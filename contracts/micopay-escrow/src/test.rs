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
    seller: Address,
    buyer: Address,
    platform_wallet: Address,
    token_id: Address,
}

impl TestEnv {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let seller = Address::generate(&env);
        let buyer = Address::generate(&env);
        let platform_wallet = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = sac.address();
        token::StellarAssetClient::new(&env, &token_id).mint(&seller, &1_000_000_000_000);

        let contract_id = env.register_contract(None, EscrowFactory);
        let escrow = EscrowFactoryClient::new(&env, &contract_id);
        escrow.initialize(&admin, &token_id, &platform_wallet);

        TestEnv { env, contract_id, admin, seller, buyer, platform_wallet, token_id }
    }

    fn escrow(&self) -> EscrowFactoryClient<'_> {
        EscrowFactoryClient::new(&self.env, &self.contract_id)
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
        let trade_id = self.escrow().lock(
            &self.seller, &self.buyer,
            &1_000_000_000, &8_000_000, &hash, &30u32,
        );
        (trade_id, secret)
    }

    fn advance_past_timeout(&self, minutes: u32) {
        let current = self.env.ledger().get();
        let ledgers = minutes * 12 + 5; // ~12 ledgers/minute + buffer
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
    let result = t.escrow().try_initialize(&t.admin, &t.token_id, &t.platform_wallet);
    assert!(result.is_err(), "Second initialize must fail");
}

// ─── Happy path ─────────────────────────────────────────────────────────────

#[test]
fn test_lock_transfers_total_to_contract() {
    let t = TestEnv::new();
    let amount: i128 = 1_500_000_000;
    let fee: i128 = 12_000_000;
    let balance_before = t.token().balance(&t.seller);

    let (_, hash) = t.make_secret();
    t.escrow().lock(&t.seller, &t.buyer, &amount, &fee, &hash, &30u32);

    // Seller lost amount + fee
    assert_eq!(t.token().balance(&t.seller), balance_before - amount - fee);
    // Contract holds amount + fee
    assert_eq!(t.token().balance(&t.contract_id), amount + fee);
}

#[test]
fn test_release_pays_buyer_and_platform() {
    let t = TestEnv::new();
    let amount: i128 = 1_500_000_000;
    let fee: i128 = 12_000_000;
    let (secret, hash) = t.make_secret();

    let trade_id = t.escrow().lock(&t.seller, &t.buyer, &amount, &fee, &hash, &30u32);
    t.escrow().release(&trade_id, &secret);

    assert_eq!(t.token().balance(&t.buyer), amount,           "buyer gets amount");
    assert_eq!(t.token().balance(&t.platform_wallet), fee,    "platform gets fee");
    assert_eq!(t.token().balance(&t.contract_id), 0,          "contract emptied");
}

#[test]
fn test_release_sets_status_released() {
    let t = TestEnv::new();
    let (trade_id, secret) = t.lock_default();
    t.escrow().release(&trade_id, &secret);
    assert_eq!(t.escrow().get_trade(&trade_id).status, TradeStatus::Released);
}

#[test]
fn test_refund_returns_full_amount_to_seller() {
    // Seller gets back amount + fee after timeout
    let t = TestEnv::new();
    let amount: i128 = 1_500_000_000;
    let fee: i128 = 12_000_000;
    let seller_start = t.token().balance(&t.seller);

    let secret = Bytes::from_slice(&t.env, b"refund_secret_32_bytes_long_pad!!");
    let hash: BytesN<32> = t.env.crypto().sha256(&secret).into();

    let trade_id = t.escrow().lock(&t.seller, &t.buyer, &amount, &fee, &hash, &1u32);
    t.advance_past_timeout(1);
    t.escrow().refund(&trade_id);

    assert_eq!(t.token().balance(&t.seller), seller_start,  "seller fully refunded");
    assert_eq!(t.token().balance(&t.platform_wallet), 0,    "platform gets nothing on refund");
    assert_eq!(t.escrow().get_trade(&trade_id).status, TradeStatus::Refunded);
}

#[test]
fn test_zero_fee_works() {
    // Platform fee of 0 is valid
    let t = TestEnv::new();
    let amount: i128 = 500_000_000;
    let (secret, hash) = t.make_secret();

    let trade_id = t.escrow().lock(&t.seller, &t.buyer, &amount, &0, &hash, &30u32);
    t.escrow().release(&trade_id, &secret);

    assert_eq!(t.token().balance(&t.buyer), amount);
    assert_eq!(t.token().balance(&t.platform_wallet), 0);
}

#[test]
fn test_get_trade_reflects_correct_amounts() {
    let t = TestEnv::new();
    let amount: i128 = 2_000_000_000;
    let fee: i128 = 16_000_000;
    let (_, hash) = t.make_secret();

    let trade_id = t.escrow().lock(&t.seller, &t.buyer, &amount, &fee, &hash, &60u32);
    let trade = t.escrow().get_trade(&trade_id);

    assert_eq!(trade.amount, amount);
    assert_eq!(trade.platform_fee, fee);
    assert_eq!(trade.seller, t.seller);
    assert_eq!(trade.buyer, t.buyer);
    assert_eq!(trade.status, TradeStatus::Locked);
}

// ─── Security: secret integrity ─────────────────────────────────────────────

#[test]
#[should_panic]
fn test_wrong_secret_rejected() {
    let t = TestEnv::new();
    let (trade_id, _) = t.lock_default();
    let wrong = Bytes::from_slice(&t.env, b"wrong_secret_not_matching_hash!!");
    t.escrow().release(&trade_id, &wrong);
}

#[test]
#[should_panic]
fn test_empty_secret_rejected() {
    let t = TestEnv::new();
    let (trade_id, _) = t.lock_default();
    t.escrow().release(&trade_id, &Bytes::from_slice(&t.env, b""));
}

// ─── Security: state machine ─────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_refund_before_timeout_rejected() {
    let t = TestEnv::new();
    let (trade_id, _) = t.lock_default();
    t.escrow().refund(&trade_id); // timeout not reached → must panic
}

#[test]
#[should_panic]
fn test_double_release_rejected() {
    let t = TestEnv::new();
    let (trade_id, secret) = t.lock_default();
    t.escrow().release(&trade_id, &secret);
    t.escrow().release(&trade_id, &secret); // second → not Locked → must panic
}

#[test]
#[should_panic]
fn test_refund_after_release_rejected() {
    let t = TestEnv::new();
    let (trade_id, secret) = t.lock_default();
    t.escrow().release(&trade_id, &secret);
    t.advance_past_timeout(30);
    t.escrow().refund(&trade_id); // already Released → must panic
}

#[test]
#[should_panic]
fn test_zero_amount_rejected() {
    let t = TestEnv::new();
    let (_, hash) = t.make_secret();
    t.escrow().lock(&t.seller, &t.buyer, &0, &0, &hash, &30u32);
}

#[test]
#[should_panic]
fn test_negative_amount_rejected() {
    let t = TestEnv::new();
    let (_, hash) = t.make_secret();
    t.escrow().lock(&t.seller, &t.buyer, &-100, &0, &hash, &30u32);
}

#[test]
#[should_panic]
fn test_duplicate_lock_same_secret_rejected() {
    // Reusing the same secret_hash produces the same trade_id — must be rejected
    // to prevent overwriting a locked trade and trapping funds.
    let t = TestEnv::new();
    let (_, hash) = t.make_secret();

    t.escrow().lock(&t.seller, &t.buyer, &500_000_000, &0, &hash, &30u32);

    // Mint more so the transfer can succeed if the guard is missing
    use soroban_sdk::token::StellarAssetClient;
    StellarAssetClient::new(&t.env, &t.token_id).mint(&t.seller, &500_000_000);
    t.escrow().lock(&t.seller, &t.buyer, &500_000_000, &0, &hash, &30u32); // must panic
}

// ─── Accounting invariant ────────────────────────────────────────────────────

#[test]
fn test_accounting_invariant_on_release() {
    // Total tokens in the system never change
    let t = TestEnv::new();
    let amount: i128 = 1_000_000_000;
    let fee: i128 = 10_000_000;
    let (secret, hash) = t.make_secret();

    let total_supply = t.token().balance(&t.seller); // all tokens start with seller

    let trade_id = t.escrow().lock(&t.seller, &t.buyer, &amount, &fee, &hash, &30u32);
    t.escrow().release(&trade_id, &secret);

    let seller_final = t.token().balance(&t.seller);
    let buyer_final = t.token().balance(&t.buyer);
    let platform_final = t.token().balance(&t.platform_wallet);
    let contract_final = t.token().balance(&t.contract_id);

    assert_eq!(
        seller_final + buyer_final + platform_final + contract_final,
        total_supply,
        "No tokens created or destroyed"
    );
    assert_eq!(buyer_final, amount);
    assert_eq!(platform_final, fee);
    assert_eq!(contract_final, 0);
}

#[test]
fn test_accounting_invariant_on_refund() {
    let t = TestEnv::new();
    let amount: i128 = 1_000_000_000;
    let fee: i128 = 10_000_000;
    let (_, hash) = t.make_secret();

    let total_supply = t.token().balance(&t.seller);

    let trade_id = t.escrow().lock(&t.seller, &t.buyer, &amount, &fee, &hash, &1u32);
    t.advance_past_timeout(1);
    t.escrow().refund(&trade_id);

    let seller_final = t.token().balance(&t.seller);
    let buyer_final = t.token().balance(&t.buyer);
    let platform_final = t.token().balance(&t.platform_wallet);
    let contract_final = t.token().balance(&t.contract_id);

    assert_eq!(
        seller_final + buyer_final + platform_final + contract_final,
        total_supply,
        "No tokens created or destroyed"
    );
    assert_eq!(seller_final, total_supply, "Full refund to seller");
    assert_eq!(buyer_final, 0);
    assert_eq!(platform_final, 0);
}
