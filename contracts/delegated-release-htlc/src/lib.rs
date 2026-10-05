#![no_std]

mod errors;
mod types;

use errors::EscrowError;
use htlc_core::{TTL_EXTEND, TTL_MIN};
use types::{DataKey, TradeEscrow, TradeStatus};

use soroban_sdk::{contract, contractimpl, log, symbol_short, token, Address, Bytes, BytesN, Env};

fn compute_trade_id(
    env: &Env,
    _initiator: &Address,
    _beneficiary: &Address,
    secret_hash: &BytesN<32>,
) -> BytesN<32> {
    let seed = Bytes::from_slice(env, &secret_hash.to_array());
    env.crypto().sha256(&seed).into()
}

/// DelegatedReleaseHTLC — Delegated-release HTLC variant following the HashedTimeLock pattern.
///
/// Extends the base HTLC pattern with:
/// - initiator (locks funds) / beneficiary (receives funds)
/// - Platform fee collection
/// - permissionless release (no require_auth) for third-party escrow
#[contract]
pub struct DelegatedReleaseHTLC;

#[contractimpl]
impl DelegatedReleaseHTLC {
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

    pub fn lock(
        env: Env,
        initiator: Address,
        beneficiary: Address,
        amount: i128,
        platform_fee: i128,
        secret_hash: BytesN<32>,
        timeout_minutes: u32,
    ) -> Result<BytesN<32>, EscrowError> {
        initiator.require_auth();

        if amount <= 0 || platform_fee < 0 {
            return Err(EscrowError::InsufficientAmount);
        }

        let token_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenId)
            .ok_or(EscrowError::NotInitialized)?;

        let trade_id = compute_trade_id(&env, &initiator, &beneficiary, &secret_hash);

        if env
            .storage()
            .persistent()
            .has(&DataKey::Trade(trade_id.clone()))
        {
            return Err(EscrowError::TradeAlreadyExists);
        }

        let total = amount + platform_fee;
        let token_client = token::Client::new(&env, &token_id);
        token_client.transfer(&initiator, &env.current_contract_address(), &total);

        let timeout_ledgers = timeout_minutes
            .checked_mul(12)
            .ok_or(EscrowError::InvalidTimeout)?;
        let timeout_ledger = env
            .ledger()
            .sequence()
            .checked_add(timeout_ledgers)
            .ok_or(EscrowError::InvalidTimeout)?;

        let trade = TradeEscrow {
            initiator: initiator.clone(),
            beneficiary: beneficiary.clone(),
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
            (
                trade_id.clone(),
                initiator,
                beneficiary,
                amount,
                timeout_ledger,
            ),
        );

        log!(
            &env,
            "Trade locked: amount={}, timeout_ledger={}",
            amount,
            timeout_ledger
        );

        Ok(trade_id)
    }

    pub fn release(env: Env, trade_id: BytesN<32>, secret: Bytes) -> Result<(), EscrowError> {
        let mut trade: TradeEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id.clone()))
            .ok_or(EscrowError::TradeNotFound)?;

        if trade.status != TradeStatus::Locked {
            return Err(EscrowError::TradeNotLocked);
        }

        // NO require_auth() HERE
        // Permissionless release for third-party escrow.

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
        token_client.transfer(
            &env.current_contract_address(),
            &trade.beneficiary,
            &trade.amount,
        );

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
            (trade_id, trade.initiator, trade.beneficiary),
        );

        Ok(())
    }

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
        token_client.transfer(&env.current_contract_address(), &trade.initiator, &total);

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
            (trade_id, trade.initiator.clone()),
        );

        Ok(())
    }

    pub fn get_trade(env: Env, trade_id: BytesN<32>) -> Result<TradeEscrow, EscrowError> {
        let trade: TradeEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Trade(trade_id.clone()))
            .ok_or(EscrowError::TradeNotFound)?;
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Trade(trade_id), TTL_MIN, TTL_EXTEND);
        Ok(trade)
    }
}

#[cfg(test)]
mod test;
