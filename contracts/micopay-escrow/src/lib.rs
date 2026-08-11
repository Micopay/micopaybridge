#![no_std]

mod errors;
mod types;

use errors::EscrowError;
use htlc_core::{TTL_EXTEND, TTL_MIN};
use types::{DataKey, TradeEscrow, TradeStatus};

use soroban_sdk::{
    contract, contractimpl, symbol_short, token, Address, Bytes, BytesN, Env, log,
};

fn compute_trade_id(
    env: &Env,
    _seller: &Address,
    _buyer: &Address,
    secret_hash: &BytesN<32>,
) -> BytesN<32> {
    // Deterministic: only use secret_hash.
    // secret_hash = sha256(random_secret), so this = sha256(sha256(secret)) = unique.
    let seed = Bytes::from_slice(env, &secret_hash.to_array());
    env.crypto().sha256(&seed).into()
}

/// MicopayEscrow — P2P escrow contract implementing HashedTimeLock.
///
/// Extends the base HTLC with P2P-specific business logic:
/// - Seller/buyer roles (vs generic initiator/counterparty)
/// - Platform fee collection
/// - Dispute mechanism
/// - Reputation hooks
///
/// Shares the HashedTimeLock interface with AtomicSwapHTLC,
/// so the same SDK client can interact with both contracts.
#[contract]
pub struct EscrowFactory;

#[contractimpl]
impl EscrowFactory {
    /// Initialize the contract with admin, token address, and platform wallet.
    pub fn initialize(
        env: Env,
        admin: Address,
        token_id: Address,
        platform_wallet: Address,
    ) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenId, &token_id);
        env.storage()
            .instance()
            .set(&DataKey::PlatformWallet, &platform_wallet);
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);
        Ok(())
    }

    /// Lock funds in P2P escrow.
    ///
    /// Maps to HashedTimeLock::lock() but preserves P2P semantics:
    /// - seller = initiator (locks funds)
    /// - buyer = counterparty (receives funds on release)
    /// - platform_fee is collected separately from amount
    pub fn lock(
        env: Env,
        seller: Address,
        buyer: Address,
        amount: i128,
        platform_fee: i128,
        secret_hash: BytesN<32>,
        timeout_minutes: u32,
    ) -> Result<BytesN<32>, EscrowError> {
        seller.require_auth();

        if amount <= 0 || platform_fee < 0 {
            return Err(EscrowError::InsufficientAmount);
        }

        let token_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenId)
            .ok_or(EscrowError::NotInitialized)?;

        let trade_id = compute_trade_id(&env, &seller, &buyer, &secret_hash);

        // Prevent duplicate trades (same secret_hash = same trade_id → funds would be stuck)
        if env.storage().persistent().has(&DataKey::Trade(trade_id.clone())) {
            return Err(EscrowError::TradeAlreadyExists);
        }

        let total = amount + platform_fee;
        let token_client = token::Client::new(&env, &token_id);
        token_client.transfer(&seller, &env.current_contract_address(), &total);

        // ~12 ledgers per minute at 5s/ledger
        let timeout_ledger = env.ledger().sequence() + (timeout_minutes * 12);

        let trade = TradeEscrow {
            seller: seller.clone(),
            buyer: buyer.clone(),
            amount,
            platform_fee,
            secret_hash,
            timeout_ledger,
            status: TradeStatus::Locked,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Trade(trade_id.clone()), &trade);
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);
        env.storage().persistent().extend_ttl(
            &DataKey::Trade(trade_id.clone()),
            TTL_MIN,
            TTL_EXTEND,
        );

        env.events().publish(
            (symbol_short!("locked"),),
            (trade_id.clone(), seller, buyer, amount, timeout_ledger),
        );

        log!(&env, "Trade locked: amount={}, timeout_ledger={}", amount, timeout_ledger);

        Ok(trade_id)
    }

    /// Release funds to buyer by presenting the secret preimage.
    pub fn release(
        env: Env,
        trade_id: BytesN<32>,
        secret: Bytes,
    ) -> Result<(), EscrowError> {
        let mut trade: TradeEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id.clone()))
            .ok_or(EscrowError::TradeNotFound)?;

        if trade.status != TradeStatus::Locked {
            return Err(EscrowError::TradeNotLocked);
        }

        trade.buyer.require_auth();

        let computed_hash: BytesN<32> = env.crypto().sha256(&secret).into();
        if computed_hash != trade.secret_hash {
            return Err(EscrowError::InvalidSecret);
        }

        let token_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenId)
            .ok_or(EscrowError::NotInitialized)?;

        let platform_wallet: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformWallet)
            .ok_or(EscrowError::NotInitialized)?;

        let token_client = token::Client::new(&env, &token_id);
        token_client.transfer(&env.current_contract_address(), &trade.buyer, &trade.amount);

        if trade.platform_fee > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &platform_wallet,
                &trade.platform_fee,
            );
        }

        trade.status = TradeStatus::Released;
        env.storage()
            .persistent()
            .set(&DataKey::Trade(trade_id.clone()), &trade);
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);
        env.storage().persistent().extend_ttl(
            &DataKey::Trade(trade_id.clone()),
            TTL_MIN,
            TTL_EXTEND,
        );

        env.events().publish(
            (symbol_short!("released"),),
            (trade_id, trade.seller, trade.buyer),
        );

        Ok(())
    }

    /// Refund seller after timeout. Can be called by anyone.
    pub fn refund(env: Env, trade_id: BytesN<32>) -> Result<(), EscrowError> {
        let mut trade: TradeEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id.clone()))
            .ok_or(EscrowError::TradeNotFound)?;

        if trade.status != TradeStatus::Locked {
            return Err(EscrowError::TradeNotLocked);
        }

        if env.ledger().sequence() < trade.timeout_ledger {
            return Err(EscrowError::TimeoutNotReached);
        }

        let token_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenId)
            .ok_or(EscrowError::NotInitialized)?;

        let token_client = token::Client::new(&env, &token_id);
        let total = trade.amount + trade.platform_fee;
        token_client.transfer(&env.current_contract_address(), &trade.seller, &total);

        trade.status = TradeStatus::Refunded;
        env.storage()
            .persistent()
            .set(&DataKey::Trade(trade_id.clone()), &trade);
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);
        env.storage().persistent().extend_ttl(
            &DataKey::Trade(trade_id.clone()),
            TTL_MIN,
            TTL_EXTEND,
        );

        env.events().publish(
            (symbol_short!("refunded"),),
            (trade_id, trade.seller.clone()),
        );

        Ok(())
    }

    /// Get trade state (view function).
    pub fn get_trade(env: Env, trade_id: BytesN<32>) -> Result<TradeEscrow, EscrowError> {
        let trade: TradeEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id.clone()))
            .ok_or(EscrowError::TradeNotFound)?;
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);
        env.storage().persistent().extend_ttl(
            &DataKey::Trade(trade_id),
            TTL_MIN,
            TTL_EXTEND,
        );
        Ok(trade)
    }
}

#[cfg(test)]
mod test;
