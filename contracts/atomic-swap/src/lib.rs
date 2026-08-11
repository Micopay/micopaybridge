#![no_std]

use htlc_core::{
    types::SwapStatus,
    MIN_TIMEOUT_LEDGERS, TTL_EXTEND, TTL_MIN,
};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Swap(BytesN<32>),
}

#[contracttype]
#[derive(Clone)]
pub struct AtomicSwap {
    pub initiator: Address,
    pub counterparty: Address,
    pub token: Address,
    pub amount: i128,
    pub secret_hash: BytesN<32>,
    /// Absolute ledger when initiator can reclaim funds
    pub timeout_ledger: u32,
    pub status: SwapStatus,
}

/// AtomicSwapHTLC — clean HTLC for cross-chain atomic swaps.
///
/// No business logic, no fees, no disputes.
/// Atomicity is guaranteed by cryptography: the same secret unlocks
/// funds on both chains. If the counterparty reveals the secret on
/// chain B, the initiator can use it to claim on chain A.
///
/// Key invariant: initiator_timeout > counterparty_timeout
/// This gives the initiator time to react after counterparty reveals.
#[contract]
pub struct AtomicSwapHTLC;

#[contractimpl]
impl AtomicSwapHTLC {
    /// Lock funds for a cross-chain atomic swap.
    ///
    /// - `initiator`: party locking funds (must auth)
    /// - `counterparty`: party who can release with the secret
    /// - `token`: SAC token address
    /// - `amount`: amount to lock
    /// - `secret_hash`: sha256(secret) — preimage is the unlock key
    /// - `timeout_ledgers`: ledgers from now until initiator can refund
    ///
    /// Returns the swap_id (sha256 of secret_hash for determinism).
    pub fn lock(
        env: Env,
        initiator: Address,
        counterparty: Address,
        token: Address,
        amount: i128,
        secret_hash: BytesN<32>,
        timeout_ledgers: u32,
    ) -> BytesN<32> {
        initiator.require_auth();

        assert!(amount > 0, "Amount must be positive");
        assert!(
            timeout_ledgers >= MIN_TIMEOUT_LEDGERS,
            "Timeout too short for safe cross-chain operation"
        );

        let swap_id = Self::compute_swap_id(&env, &secret_hash);

        // Ensure swap doesn't already exist
        assert!(
            !env.storage().persistent().has(&DataKey::Swap(swap_id.clone())),
            "Swap already exists"
        );

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&initiator, &env.current_contract_address(), &amount);

        let timeout_ledger = env.ledger().sequence() + timeout_ledgers;

        let swap = AtomicSwap {
            initiator: initiator.clone(),
            counterparty: counterparty.clone(),
            token,
            amount,
            secret_hash,
            timeout_ledger,
            status: SwapStatus::Locked,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Swap(swap_id.clone()), &swap);
        env.storage().persistent().extend_ttl(
            &DataKey::Swap(swap_id.clone()),
            TTL_MIN,
            TTL_EXTEND,
        );

        // Agents monitor this event to detect new swaps
        env.events().publish(
            (symbol_short!("locked"),),
            (
                swap_id.clone(),
                initiator,
                counterparty,
                amount,
                timeout_ledger,
            ),
        );

        swap_id
    }

    /// Release funds to counterparty by revealing the secret.
    ///
    /// The secret is emitted in the event — this is intentional.
    /// The counterparty's agent on chain B watches for this event
    /// and uses the revealed secret to claim funds there.
    pub fn release(env: Env, swap_id: BytesN<32>, secret: Bytes) {
        let mut swap: AtomicSwap = env
            .storage()
            .persistent()
            .get(&DataKey::Swap(swap_id.clone()))
            .expect("Swap not found");

        assert!(swap.status == SwapStatus::Locked, "Swap not in locked state");

        swap.counterparty.require_auth();

        let computed_hash: BytesN<32> = env.crypto().sha256(&secret).into();
        assert!(computed_hash == swap.secret_hash, "Invalid secret");

        let token_client = token::Client::new(&env, &swap.token);
        token_client.transfer(
            &env.current_contract_address(),
            &swap.counterparty,
            &swap.amount,
        );

        swap.status = SwapStatus::Released;
        env.storage()
            .persistent()
            .set(&DataKey::Swap(swap_id.clone()), &swap);
        env.storage().persistent().extend_ttl(
            &DataKey::Swap(swap_id.clone()),
            TTL_MIN,
            TTL_EXTEND,
        );

        // SECRET IS PUBLISHED HERE — this is the cross-chain coordination mechanism.
        // The initiator's agent on the other chain reads this event to get the secret.
        env.events().publish(
            (symbol_short!("released"),),
            (swap_id, secret), // <-- secret revealed on-chain
        );
    }

    /// Refund initiator after timeout. Anyone can call this.
    pub fn refund(env: Env, swap_id: BytesN<32>) {
        let mut swap: AtomicSwap = env
            .storage()
            .persistent()
            .get(&DataKey::Swap(swap_id.clone()))
            .expect("Swap not found");

        assert!(swap.status == SwapStatus::Locked, "Swap not in locked state");
        assert!(
            env.ledger().sequence() >= swap.timeout_ledger,
            "Timeout not reached yet"
        );

        let token_client = token::Client::new(&env, &swap.token);
        token_client.transfer(
            &env.current_contract_address(),
            &swap.initiator,
            &swap.amount,
        );

        swap.status = SwapStatus::Refunded;
        env.storage()
            .persistent()
            .set(&DataKey::Swap(swap_id.clone()), &swap);
        env.storage().persistent().extend_ttl(
            &DataKey::Swap(swap_id.clone()),
            TTL_MIN,
            TTL_EXTEND,
        );

        env.events().publish(
            (symbol_short!("refunded"),),
            (swap_id, swap.initiator),
        );
    }

    /// Get swap status — view function.
    pub fn get_status(env: Env, swap_id: BytesN<32>) -> SwapStatus {
        let swap: AtomicSwap = env
            .storage()
            .persistent()
            .get(&DataKey::Swap(swap_id))
            .expect("Swap not found");
        swap.status
    }

    /// Get full swap data — view function.
    pub fn get_swap(env: Env, swap_id: BytesN<32>) -> AtomicSwap {
        env.storage()
            .persistent()
            .get(&DataKey::Swap(swap_id))
            .expect("Swap not found")
    }

    // --- Internal ---

    fn compute_swap_id(env: &Env, secret_hash: &BytesN<32>) -> BytesN<32> {
        // swap_id = sha256(secret_hash) — deterministic, unique
        let seed = Bytes::from_slice(env, &secret_hash.to_array());
        env.crypto().sha256(&seed).into()
    }
}

#[cfg(test)]
mod test;
