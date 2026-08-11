#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Bytes, Env,
};

// ─── helpers ────────────────────────────────────────────────────────────────

struct TestEnv {
    env: Env,
    contract_id: Address,
    initiator: Address,
    counterparty: Address,
    token_id: Address,
}

impl TestEnv {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let initiator = Address::generate(&env);
        let counterparty = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        StellarAssetClient::new(&env, &token_id).mint(&initiator, &1_000_000_000);

        let contract_id = env.register_contract(None, AtomicSwapHTLC);

        TestEnv { env, contract_id, initiator, counterparty, token_id }
    }

    fn client(&self) -> AtomicSwapHTLCClient {
        AtomicSwapHTLCClient::new(&self.env, &self.contract_id)
    }

    fn token(&self) -> TokenClient {
        TokenClient::new(&self.env, &self.token_id)
    }

    fn make_secret(&self) -> (Bytes, BytesN<32>) {
        let secret = Bytes::from_slice(&self.env, b"super_secret_preimage_32bytes_xx");
        let hash: BytesN<32> = self.env.crypto().sha256(&secret).into();
        (secret, hash)
    }

    fn lock_default(&self) -> (BytesN<32>, Bytes) {
        let (secret, hash) = self.make_secret();
        let swap_id = self.client().lock(
            &self.initiator,
            &self.counterparty,
            &self.token_id,
            &100_000_000,
            &hash,
            &MIN_TIMEOUT_LEDGERS,
        );
        (swap_id, secret)
    }

    fn advance_past_timeout(&self, timeout: u32) {
        let current = self.env.ledger().get();
        self.env.ledger().set(LedgerInfo {
            timestamp: current.timestamp + (timeout as u64) * 5 + 10,
            sequence_number: current.sequence_number + timeout + 1,
            ..current
        });
    }
}

// ─── Happy path ─────────────────────────────────────────────────────────────

#[test]
fn test_lock_transfers_funds_to_contract() {
    let t = TestEnv::new();
    let initiator_balance_before = t.token().balance(&t.initiator);
    let amount: i128 = 100_000_000;

    t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &amount, &t.make_secret().1, &MIN_TIMEOUT_LEDGERS,
    );

    // Initiator lost `amount`, contract holds it
    assert_eq!(t.token().balance(&t.initiator), initiator_balance_before - amount);
    assert_eq!(t.token().balance(&t.contract_id), amount);
}

#[test]
fn test_lock_status_is_locked() {
    let t = TestEnv::new();
    let (swap_id, _) = t.lock_default();
    assert_eq!(t.client().get_swap(&swap_id).status, SwapStatus::Locked);
}

#[test]
fn test_release_moves_funds_to_counterparty() {
    let t = TestEnv::new();
    let amount: i128 = 100_000_000;
    let (secret, hash) = t.make_secret();

    let swap_id = t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &amount, &hash, &MIN_TIMEOUT_LEDGERS,
    );

    t.client().release(&swap_id, &secret);

    assert_eq!(t.token().balance(&t.counterparty), amount);
    assert_eq!(t.token().balance(&t.contract_id), 0);
    assert_eq!(t.client().get_swap(&swap_id).status, SwapStatus::Released);
}

#[test]
fn test_refund_returns_funds_to_initiator() {
    let t = TestEnv::new();
    let amount: i128 = 250_000_000;
    let balance_before = t.token().balance(&t.initiator);

    let (secret_hash) = t.make_secret().1;
    let swap_id = t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &amount, &secret_hash, &MIN_TIMEOUT_LEDGERS,
    );

    t.advance_past_timeout(MIN_TIMEOUT_LEDGERS);
    t.client().refund(&swap_id);

    assert_eq!(t.token().balance(&t.initiator), balance_before);
    assert_eq!(t.token().balance(&t.contract_id), 0);
    assert_eq!(t.client().get_swap(&swap_id).status, SwapStatus::Refunded);
}

#[test]
fn test_swap_id_is_deterministic() {
    // Same secret_hash → same swap_id, always
    let t = TestEnv::new();
    let (_, hash) = t.make_secret();

    let id1 = t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &50_000_000, &hash, &MIN_TIMEOUT_LEDGERS,
    );

    // Compute expected id manually: sha256(secret_hash)
    let seed = soroban_sdk::Bytes::from_slice(&t.env, &hash.to_array());
    let expected: BytesN<32> = t.env.crypto().sha256(&seed).into();

    assert_eq!(id1, expected, "swap_id must be sha256(secret_hash)");
}

#[test]
fn test_multiple_swaps_independent() {
    // Two swaps with different secrets don't interfere
    let t = TestEnv::new();
    let amount: i128 = 100_000_000;

    // Mint enough for two swaps
    StellarAssetClient::new(&t.env, &t.token_id).mint(&t.initiator, &amount);

    let secret1 = Bytes::from_slice(&t.env, b"secret_number_one_32_bytes_xxxxx");
    let hash1: BytesN<32> = t.env.crypto().sha256(&secret1).into();

    let secret2 = Bytes::from_slice(&t.env, b"secret_number_two_32_bytes_xxxxx");
    let hash2: BytesN<32> = t.env.crypto().sha256(&secret2).into();

    let id1 = t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &amount, &hash1, &MIN_TIMEOUT_LEDGERS,
    );
    let id2 = t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &amount, &hash2, &MIN_TIMEOUT_LEDGERS,
    );

    // IDs must differ
    assert_ne!(id1, id2);

    // Release only swap 1
    t.client().release(&id1, &secret1);

    // Swap 2 still locked
    assert_eq!(t.client().get_swap(&id1).status, SwapStatus::Released);
    assert_eq!(t.client().get_swap(&id2).status, SwapStatus::Locked);
}

// ─── Security: timeout constraints ──────────────────────────────────────────

#[test]
#[should_panic]
fn test_timeout_below_minimum_rejected() {
    let t = TestEnv::new();
    // MIN_TIMEOUT_LEDGERS = 60; anything below must panic
    t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &100_000_000, &t.make_secret().1, &(MIN_TIMEOUT_LEDGERS - 1),
    );
}

#[test]
#[should_panic]
fn test_refund_before_timeout_rejected() {
    let t = TestEnv::new();
    let (swap_id, _) = t.lock_default();
    // Timeout not reached — must panic
    t.client().refund(&swap_id);
}

// ─── Security: secret integrity ─────────────────────────────────────────────

#[test]
#[should_panic]
fn test_wrong_secret_rejected() {
    let t = TestEnv::new();
    let (swap_id, _) = t.lock_default();
    let wrong = Bytes::from_slice(&t.env, b"totally_wrong_secret_32bytes_xxx");
    t.client().release(&swap_id, &wrong);
}

#[test]
#[should_panic]
fn test_empty_secret_rejected() {
    let t = TestEnv::new();
    let (swap_id, _) = t.lock_default();
    let empty = Bytes::from_slice(&t.env, b"");
    t.client().release(&swap_id, &empty);
}

// ─── Security: state machine ─────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_double_release_rejected() {
    let t = TestEnv::new();
    let (secret, hash) = t.make_secret();
    let swap_id = t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &100_000_000, &hash, &MIN_TIMEOUT_LEDGERS,
    );

    t.client().release(&swap_id, &secret); // first release — ok
    t.client().release(&swap_id, &secret); // second — must panic (not Locked)
}

#[test]
#[should_panic]
fn test_refund_after_release_rejected() {
    let t = TestEnv::new();
    let (secret, hash) = t.make_secret();
    let swap_id = t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &100_000_000, &hash, &MIN_TIMEOUT_LEDGERS,
    );

    t.client().release(&swap_id, &secret);

    t.advance_past_timeout(MIN_TIMEOUT_LEDGERS);
    t.client().refund(&swap_id); // already Released — must panic
}

#[test]
#[should_panic]
fn test_duplicate_lock_same_secret_rejected() {
    let t = TestEnv::new();
    let (_, hash) = t.make_secret();

    // Lock once
    t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &50_000_000, &hash, &MIN_TIMEOUT_LEDGERS,
    );

    // Try to lock again with same secret_hash — same swap_id → must panic
    StellarAssetClient::new(&t.env, &t.token_id).mint(&t.initiator, &50_000_000);
    t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &50_000_000, &hash, &MIN_TIMEOUT_LEDGERS,
    );
}

#[test]
#[should_panic]
fn test_zero_amount_rejected() {
    let t = TestEnv::new();
    t.client().lock(
        &t.initiator, &t.counterparty, &t.token_id,
        &0, &t.make_secret().1, &MIN_TIMEOUT_LEDGERS,
    );
}

// ─── Security: get_swap on unknown id ───────────────────────────────────────

#[test]
#[should_panic]
fn test_get_swap_unknown_id_panics() {
    let t = TestEnv::new();
    let fake_id = Bytes::from_slice(&t.env, &[0u8; 32]);
    let fake_id_bytes: BytesN<32> = t.env.crypto().sha256(&fake_id).into();
    t.client().get_swap(&fake_id_bytes); // must panic: "Swap not found"
}
