#![no_std]

use soroban_sdk::{Bytes, BytesN, Env};

/// Shared types for all HTLC implementations
pub mod types {
    use soroban_sdk::{contracttype, Address, BytesN};

    #[contracttype]
    #[derive(Clone, Debug, PartialEq)]
    pub enum SwapStatus {
        Locked,
        Released,
        Refunded,
    }

    #[contracttype]
    #[derive(Clone, Debug)]
    pub struct LockParams {
        pub initiator: Address,
        pub counterparty: Address,
        pub token: Address,
        pub amount: i128,
        pub secret_hash: BytesN<32>,
        pub timeout_ledgers: u32,
    }
}

/// The HashedTimeLock trait — shared interface for all HTLC contracts.
/// MicopayEscrow and AtomicSwapHTLC both implement this interface.
pub trait HashedTimeLock {
    /// Lock funds. Returns the swap/trade ID.
    fn lock(env: Env, params: types::LockParams) -> BytesN<32>;

    /// Release funds to counterparty by revealing the secret preimage.
    fn release(env: Env, id: BytesN<32>, secret: Bytes);

    /// Refund initiator after timeout has passed.
    fn refund(env: Env, id: BytesN<32>);

    /// Get current status of a lock.
    fn get_status(env: Env, id: BytesN<32>) -> types::SwapStatus;
}

/// Minimum timeout in ledgers (~5 min at 5s/ledger).
/// Cross-chain ops need buffer time for the counterparty to act.
pub const MIN_TIMEOUT_LEDGERS: u32 = 60;

/// TTL constants (~5s per ledger)
pub const TTL_MIN: u32 = 17_280;    // ~1 day
pub const TTL_EXTEND: u32 = 518_400; // ~30 days
