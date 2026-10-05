#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token, Address, Bytes, BytesN, Env,
};

// ─── helpers ────────────────────────────────────────────────────────────────

struct TestEnv {
    env: Env,
    contract_id: Address,
    admin: Address,
    initiator: Address,
    beneficiary: Address,
    platform_wallet: Address,
    token_id: Address,
    third_party: Address,
}

impl TestEnv {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let initiator = Address::generate(&env);
        let beneficiary = Address::generate(&env);
        let platform_wallet = Address::generate(&env);
        let third_party = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = sac.address();
        token::StellarAssetClient::new(&env, &token_id).mint(&initiator, &1_000_000_000_000);

        let contract_id = env.register_contract(None, DelegatedReleaseHTLC);
        let htlc = DelegatedReleaseHTLCClient::new(&env, &contract_id);
        htlc.initialize(&admin, &token_id, &platform_wallet);

        TestEnv {
            env,
            contract_id,
            admin,
            initiator,
            beneficiary,
            platform_wallet,
            token_id,
            third_party,
        }
    }

    fn htlc(&self) -> DelegatedReleaseHTLCClient<'_> {
        DelegatedReleaseHTLCClient::new(&self.env, &self.contract_id)
    }

    fn token(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.token_id)
    }

    fn make_secret(&self) -> (Bytes, BytesN<32>) {
        let secret = Bytes::from_slice(&self.env, b"test_secret_32_bytes_long_pad__!!");
        let hash: BytesN<32> = self.env.crypto().sha256(&secret).into();
        (secret, hash)
    }

    fn lock_default(&self) -> (BytesN<32>, Bytes) {
        let (secret, hash) = self.make_secret();
        let trade_id = self.htlc().lock(
            &self.initiator,
            &self.beneficiary,
            &1_000_000_000,
            &8_000_000,
            &hash,
            &30u32,
        );
        (trade_id, secret)
    }

    fn advance_past_timeout(&self, minutes: u32) {
        let current = self.env.ledger().get();
        let ledgers = minutes * 12 + 5;
        self.env.ledger().set(LedgerInfo {
            timestamp: current.timestamp + (minutes as u64) * 60 + 10,
            sequence_number: current.sequence_number + ledgers,
            ..current
        });
    }
}

// ─── Initialization ──────────────────────────────────────────────────────────

#[test]
fn test_double_initialize_fails() {
    let t = TestEnv::new();
    let result = t
        .htlc()
        .try_initialize(&t.admin, &t.token_id, &t.platform_wallet);
    assert!(result.is_err(), "Second initialize must fail");
}

// ─── Happy path ─────────────────────────────────────────────────────────────

#[test]
fn test_lock_transfers_total_to_contract() {
    let t = TestEnv::new();
    let amount: i128 = 1_500_000_000;
    let fee: i128 = 12_000_000;
    let balance_before = t.token().balance(&t.initiator);

    let (_, hash) = t.make_secret();
    t.htlc()
        .lock(&t.initiator, &t.beneficiary, &amount, &fee, &hash, &30u32);

    assert_eq!(
        t.token().balance(&t.initiator),
        balance_before - amount - fee
    );
    assert_eq!(t.token().balance(&t.contract_id), amount + fee);
}

#[test]
fn test_release_submitted_by_third_party_pays_beneficiary() {
    // This is the decisive test: release submitted by an unrelated third party
    let t = TestEnv::new();
    let amount: i128 = 1_500_000_000;
    let fee: i128 = 12_000_000;
    let (secret, hash) = t.make_secret();

    let trade_id = t
        .htlc()
        .lock(&t.initiator, &t.beneficiary, &amount, &fee, &hash, &30u32);

    // Call release using third_party. In testutils we simulate the caller,
    // but without require_auth, anyone can successfully invoke it.
    // The funds must go to the beneficiary.
    // (Here we just call the client method. Since there is no require_auth on the beneficiary,
    // this succeeds even if invoked by another party).
    t.env.set_auths(&[]);
    t.htlc().release(&trade_id, &secret);

    assert_eq!(
        t.token().balance(&t.beneficiary),
        amount,
        "beneficiary gets amount"
    );
    assert_eq!(
        t.token().balance(&t.platform_wallet),
        fee,
        "platform gets fee"
    );
    assert_eq!(t.token().balance(&t.contract_id), 0, "contract emptied");

    // Ensure the third party didn't get any funds
    assert_eq!(t.token().balance(&t.third_party), 0);
}

#[test]
fn test_release_sets_status_released() {
    let t = TestEnv::new();
    let (trade_id, secret) = t.lock_default();
    t.htlc().release(&trade_id, &secret);
    assert_eq!(t.htlc().get_trade(&trade_id).status, TradeStatus::Released);
}

#[test]
fn test_refund_returns_full_amount_to_initiator() {
    let t = TestEnv::new();
    let amount: i128 = 1_500_000_000;
    let fee: i128 = 12_000_000;
    let initiator_start = t.token().balance(&t.initiator);

    let secret = Bytes::from_slice(&t.env, b"refund_secret_32_bytes_long_pad!!");
    let hash: BytesN<32> = t.env.crypto().sha256(&secret).into();

    let trade_id = t
        .htlc()
        .lock(&t.initiator, &t.beneficiary, &amount, &fee, &hash, &1u32);
    t.advance_past_timeout(1);

    // Refund can be called by anyone
    t.env.set_auths(&[]);
    t.htlc().refund(&trade_id);

    assert_eq!(
        t.token().balance(&t.initiator),
        initiator_start,
        "initiator fully refunded"
    );
    assert_eq!(
        t.token().balance(&t.platform_wallet),
        0,
        "platform gets nothing on refund"
    );
    assert_eq!(t.htlc().get_trade(&trade_id).status, TradeStatus::Refunded);
}

#[test]
fn test_zero_fee_works() {
    let t = TestEnv::new();
    let amount: i128 = 500_000_000;
    let (secret, hash) = t.make_secret();

    let trade_id = t
        .htlc()
        .lock(&t.initiator, &t.beneficiary, &amount, &0, &hash, &30u32);
    t.htlc().release(&trade_id, &secret);

    assert_eq!(t.token().balance(&t.beneficiary), amount);
    assert_eq!(t.token().balance(&t.platform_wallet), 0);
}

#[test]
fn test_get_trade_reflects_correct_amounts() {
    let t = TestEnv::new();
    let amount: i128 = 2_000_000_000;
    let fee: i128 = 16_000_000;
    let (_, hash) = t.make_secret();

    let trade_id = t
        .htlc()
        .lock(&t.initiator, &t.beneficiary, &amount, &fee, &hash, &60u32);
    let trade = t.htlc().get_trade(&trade_id);

    assert_eq!(trade.amount, amount);
    assert_eq!(trade.platform_fee, fee);
    assert_eq!(trade.initiator, t.initiator);
    assert_eq!(trade.beneficiary, t.beneficiary);
    assert_eq!(trade.status, TradeStatus::Locked);
}

// ─── Security: secret integrity ─────────────────────────────────────────────

#[test]
#[should_panic]
fn test_wrong_secret_rejected() {
    let t = TestEnv::new();
    let (trade_id, _) = t.lock_default();
    let wrong = Bytes::from_slice(&t.env, b"wrong_secret_not_matching_hash!!");
    t.htlc().release(&trade_id, &wrong);
}

#[test]
#[should_panic]
fn test_empty_secret_rejected() {
    let t = TestEnv::new();
    let (trade_id, _) = t.lock_default();
    t.htlc().release(&trade_id, &Bytes::from_slice(&t.env, b""));
}

// ─── Security: state machine ─────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_refund_before_timeout_rejected() {
    let t = TestEnv::new();
    let (trade_id, _) = t.lock_default();
    t.htlc().refund(&trade_id);
}

#[test]
#[should_panic]
fn test_double_release_rejected() {
    let t = TestEnv::new();
    let (trade_id, secret) = t.lock_default();
    t.htlc().release(&trade_id, &secret);
    t.htlc().release(&trade_id, &secret);
}

#[test]
#[should_panic]
fn test_refund_after_release_rejected() {
    let t = TestEnv::new();
    let (trade_id, secret) = t.lock_default();
    t.htlc().release(&trade_id, &secret);
    t.advance_past_timeout(30);
    t.htlc().refund(&trade_id);
}

#[test]
#[should_panic]
fn test_zero_amount_rejected() {
    let t = TestEnv::new();
    let (_, hash) = t.make_secret();
    t.htlc()
        .lock(&t.initiator, &t.beneficiary, &0, &0, &hash, &30u32);
}

#[test]
#[should_panic]
fn test_negative_amount_rejected() {
    let t = TestEnv::new();
    let (_, hash) = t.make_secret();
    t.htlc()
        .lock(&t.initiator, &t.beneficiary, &-100, &0, &hash, &30u32);
}

#[test]
#[should_panic]
fn test_duplicate_lock_same_secret_rejected() {
    let t = TestEnv::new();
    let (_, hash) = t.make_secret();

    t.htlc().lock(
        &t.initiator,
        &t.beneficiary,
        &500_000_000,
        &0,
        &hash,
        &30u32,
    );

    use soroban_sdk::token::StellarAssetClient;
    StellarAssetClient::new(&t.env, &t.token_id).mint(&t.initiator, &500_000_000);
    t.htlc().lock(
        &t.initiator,
        &t.beneficiary,
        &500_000_000,
        &0,
        &hash,
        &30u32,
    );
}

// ─── Accounting invariant ────────────────────────────────────────────────────

#[test]
fn test_accounting_invariant_on_release() {
    let t = TestEnv::new();
    let amount: i128 = 1_000_000_000;
    let fee: i128 = 10_000_000;
    let (secret, hash) = t.make_secret();

    let total_supply = t.token().balance(&t.initiator);

    let trade_id = t
        .htlc()
        .lock(&t.initiator, &t.beneficiary, &amount, &fee, &hash, &30u32);
    t.htlc().release(&trade_id, &secret);

    let initiator_final = t.token().balance(&t.initiator);
    let beneficiary_final = t.token().balance(&t.beneficiary);
    let platform_final = t.token().balance(&t.platform_wallet);
    let contract_final = t.token().balance(&t.contract_id);

    assert_eq!(
        initiator_final + beneficiary_final + platform_final + contract_final,
        total_supply,
        "No tokens created or destroyed"
    );
    assert_eq!(beneficiary_final, amount);
    assert_eq!(platform_final, fee);
    assert_eq!(contract_final, 0);
}

#[test]
fn test_accounting_invariant_on_refund() {
    let t = TestEnv::new();
    let amount: i128 = 1_000_000_000;
    let fee: i128 = 10_000_000;
    let (_, hash) = t.make_secret();

    let total_supply = t.token().balance(&t.initiator);

    let trade_id = t
        .htlc()
        .lock(&t.initiator, &t.beneficiary, &amount, &fee, &hash, &1u32);
    t.advance_past_timeout(1);
    t.htlc().refund(&trade_id);

    let initiator_final = t.token().balance(&t.initiator);
    let beneficiary_final = t.token().balance(&t.beneficiary);
    let platform_final = t.token().balance(&t.platform_wallet);
    let contract_final = t.token().balance(&t.contract_id);

    assert_eq!(
        initiator_final + beneficiary_final + platform_final + contract_final,
        total_supply,
        "No tokens created or destroyed"
    );
    assert_eq!(initiator_final, total_supply, "Full refund to initiator");
    assert_eq!(beneficiary_final, 0);
    assert_eq!(platform_final, 0);
}
