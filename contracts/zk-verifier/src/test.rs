#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::storage::Persistent as _, testutils::Address as _, Env,
};

fn make_env() -> Env {
    Env::default()
}

fn deploy_and_init(env: &Env) -> (ZkVerifierRegistryClient, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(ZkVerifierRegistry, ());
    let client = ZkVerifierRegistryClient::new(env, &contract_id);
    env.mock_all_auths();
    client.init(&admin);
    (client, admin)
}

#[test]
fn test_init_sets_admin() {
    let env = make_env();
    let (client, admin) = deploy_and_init(&env);
    // Second init must return AlreadyInitialized
    let result = client.try_init(&admin);
    assert!(result.is_err(), "double init should return error");
}

#[test]
fn test_register_requires_auth() {
    let env = make_env();
    let (client, _) = deploy_and_init(&env);
    // Without mocked auth a second time, register must fail
    env.mock_auths(&[]);
    let circuit_id = Symbol::new(&env, "poseidon_v1");
    let vk = Bytes::from_slice(&env, &[0xabu8; 1764]);
    let result = client.try_register_circuit(&circuit_id, &vk);
    assert!(result.is_err(), "register without auth should fail");
}

#[test]
fn test_reputation_root_roundtrip() {
    let env = make_env();
    let (client, _) = deploy_and_init(&env);
    env.mock_all_auths();

    let root = Bytes::from_slice(&env, &[0xffu8; 32]);
    client.set_reputation_root(&root);

    let got = client.get_reputation_root();
    assert_eq!(got, root);
}

#[test]
fn test_verify_unknown_circuit_returns_error() {
    let env = make_env();
    let (client, _) = deploy_and_init(&env);

    let bad_id = Symbol::new(&env, "no_such");
    let proof = Bytes::from_slice(&env, &[0u8; 14592]);
    let inputs = Bytes::from_slice(&env, &[0u8; 32]);

    let result = client.try_verify(&bad_id, &inputs, &proof);
    assert!(result.is_err(), "unknown circuit_id should return error");
}

#[test]
fn test_verify_unique_rejects_short_public_inputs() {
    let env = make_env();
    let (client, _) = deploy_and_init(&env);
    env.mock_all_auths();

    let circuit_id = Symbol::new(&env, "rep_v1");
    // No circuit registration needed: the length check runs before the VK lookup.

    // Fewer than 32 bytes — there isn't even one field for the nullifier
    let short_inputs = Bytes::from_slice(&env, &[0u8; 16]);
    let proof = Bytes::from_slice(&env, &[0u8; 14592]);

    let result = client.try_verify_unique(&circuit_id, &short_inputs, &proof);
    assert!(result.is_err(), "short public_inputs should return error");
    // Should be ProofParseError (code 7)
    let err = result.unwrap_err().unwrap();
    assert_eq!(err, ZkError::ProofParseError);
}

#[test]
fn test_verify_unique_reads_nullifier_as_last_field_64b() {
    // access_credential_v1 has 2 public inputs (64 bytes): [merkle_root, nullifier].
    // The nullifier is the LAST 32 bytes ([32..64]). This proves verify_unique's
    // generalized last-field extraction works for the 2-field layout, not just 128b.
    let env = make_env();
    let (client, _) = deploy_and_init(&env);
    env.mock_all_auths();

    let circuit_id = Symbol::new(&env, "access_v1");
    // No circuit registration needed: the nullifier-replay check runs before the VK lookup.

    // Pre-record a nullifier as if a prior spend happened
    let nullifier_bytes = [0xccu8; 32];
    let nullifier = Bytes::from_slice(&env, &nullifier_bytes);
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&nullifier, &true);
    });

    // Build 64-byte public_inputs with the nullifier at the LAST field [32..64]
    let mut inputs_arr = [0u8; 64];
    inputs_arr[32..64].copy_from_slice(&nullifier_bytes);
    let inputs = Bytes::from_slice(&env, &inputs_arr);
    let proof = Bytes::from_slice(&env, &[0u8; 14592]);

    let result = client.try_verify_unique(&circuit_id, &inputs, &proof);
    assert!(result.is_err(), "replayed nullifier (64b layout) must be rejected");
    let err = result.unwrap_err().unwrap();
    assert_eq!(err, ZkError::NullifierAlreadyUsed, "should be NullifierAlreadyUsed");
}

#[test]
fn test_verify_unique_prevents_nullifier_replay() {
    let env = make_env();
    let (client, _) = deploy_and_init(&env);
    env.mock_all_auths();

    let circuit_id = Symbol::new(&env, "rep_v1");
    // The nullifier-replay check runs BEFORE the VK lookup, so no circuit
    // registration is needed to exercise the nullifier-already-used branch.
    let nullifier_bytes = [0xbbu8; 32];
    let nullifier = Bytes::from_slice(&env, &nullifier_bytes);
    // Simulate a prior successful verify_unique by writing the nullifier
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&nullifier, &true);
    });

    // Build 128-byte public_inputs (reputation_v1 layout) with our nullifier
    // at the LAST field [96..128]
    let mut inputs_arr = [0u8; 128];
    inputs_arr[96..128].copy_from_slice(&nullifier_bytes);
    let inputs = Bytes::from_slice(&env, &inputs_arr);
    let proof = Bytes::from_slice(&env, &[0u8; 14592]);

    let result = client.try_verify_unique(&circuit_id, &inputs, &proof);
    assert!(result.is_err(), "replayed nullifier must be rejected");
    let err = result.unwrap_err().unwrap();
    assert_eq!(err, ZkError::NullifierAlreadyUsed, "should be NullifierAlreadyUsed");
}

#[test]
fn test_refresh_nullifier_extends_ttl() {
    let env = make_env();
    let (client, _) = deploy_and_init(&env);
    env.mock_all_auths();

    let nullifier_bytes = [0xddu8; 32];
    let nullifier = Bytes::from_slice(&env, &nullifier_bytes);
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&nullifier, &true);
        // Give it a short initial TTL so refresh has room to extend it.
        env.storage().persistent().extend_ttl(&nullifier, 10, 10);
    });

    let ttl_before = env.as_contract(&client.address, || {
        env.storage().persistent().get_ttl(&nullifier)
    });

    client.refresh_nullifier(&nullifier);

    let ttl_after = env.as_contract(&client.address, || {
        env.storage().persistent().get_ttl(&nullifier)
    });

    assert!(
        ttl_after > ttl_before,
        "refresh_nullifier should extend the TTL (before={ttl_before}, after={ttl_after})"
    );
    assert_eq!(
        ttl_after, NULLIFIER_TTL_MAX,
        "refresh_nullifier should extend to the network max TTL"
    );
}

#[test]
fn test_refresh_nullifier_rejects_unknown_nullifier() {
    let env = make_env();
    let (client, _) = deploy_and_init(&env);
    env.mock_all_auths();

    let unknown = Bytes::from_slice(&env, &[0xeeu8; 32]);
    let result = client.try_refresh_nullifier(&unknown);
    assert!(result.is_err(), "refreshing an unrecorded nullifier should fail");
    let err = result.unwrap_err().unwrap();
    assert_eq!(err, ZkError::UnknownNullifier);
}
