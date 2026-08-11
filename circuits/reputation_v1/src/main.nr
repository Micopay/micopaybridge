// Reputation membership + tier threshold + anti-replay circuit.
//
// Proves:
//   1. leaf = pedersen_hash([secret, tier]) is in the Merkle tree at merkle_root
//   2. tier >= tier_threshold
//   3. nullifier = pedersen_hash([secret, context]) -- binds proof to verifier/session
//
// Hash function: std::hash::pedersen_hash (BN254 Pedersen, available in nargo 1.0.0-beta.9)
// See TOOLCHAIN.md: poseidon::bn254 not exported in this nargo version.

global TREE_DEPTH: u32 = 20;

fn main(
    // private inputs
    secret: Field,
    tier: Field,
    path_elements: [Field; TREE_DEPTH],
    path_index: [u1; TREE_DEPTH],
    // public inputs
    merkle_root: pub Field,
    tier_threshold: pub Field,
    context: pub Field,
    nullifier: pub Field,
) {
    // 1. Compute leaf commitment
    let leaf = std::hash::pedersen_hash([secret, tier]);

    // 2. Recompute Merkle root
    let mut node = leaf;
    for i in 0..TREE_DEPTH {
        let sibling = path_elements[i];
        let (l, r) = if path_index[i] == 0 {
            (node, sibling)
        } else {
            (sibling, node)
        };
        node = std::hash::pedersen_hash([l, r]);
    }
    assert(node == merkle_root, "Merkle proof invalid");

    // 3. Tier threshold check
    assert(tier as u64 >= tier_threshold as u64, "Tier below threshold");

    // 4. Nullifier binds proof to a specific (verifier, session) pair
    let computed_nullifier = std::hash::pedersen_hash([secret, context]);
    assert(computed_nullifier == nullifier, "Nullifier mismatch");
}

// Output demo tree values for the Reputation Engine CLI.
// Run: nargo test compute_demo_values --show-output
// Values feed apps/api/demo/demo_tree.json (see scripts/rep-engine.ts)
#[test]
fn compute_demo_values() {
    // alice: GOLD (tier=3), single user in depth-20 tree at index 0
    // All siblings are 0 (sparse tree). path_index all 0 (always left child).
    let secret_alice: Field = 1001;
    let tier_alice: Field = 3;
    let leaf_alice = std::hash::pedersen_hash([secret_alice, tier_alice]);

    // Compute root: 20-level hash chain, each time hashing [node, 0]
    let mut node = leaf_alice;
    for _i in 0..20 {
        node = std::hash::pedersen_hash([node, 0]);
    }
    let root = node;

    // Example nullifier for context=42 (demo challenge value)
    let context_demo: Field = 42;
    let nullifier_alice = std::hash::pedersen_hash([secret_alice, context_demo]);

    // bob: SILVER (tier=2) -- same tree structure, different leaf
    let secret_bob: Field = 1002;
    let tier_bob: Field = 2;
    let leaf_bob = std::hash::pedersen_hash([secret_bob, tier_bob]);

    // charlie: BRONZE (tier=1)
    let secret_charlie: Field = 1003;
    let tier_charlie: Field = 1;
    let leaf_charlie = std::hash::pedersen_hash([secret_charlie, tier_charlie]);

    // Print values for CLI consumption
    std::println(leaf_alice);
    std::println(root);
    std::println(nullifier_alice);
    std::println(leaf_bob);
    std::println(leaf_charlie);
}

// Tests

// Trivial depth-20 tree with all siblings = 0
#[test]
fn test_trivial_tree_self_consistent() {
    let secret: Field = 42;
    let tier: Field = 3;
    let leaf = std::hash::pedersen_hash([secret, tier]);

    let path_elements: [Field; 20] = [0; 20];
    let path_index: [u1; 20] = [0; 20];

    let mut node = leaf;
    for _i in 0..20 {
        node = std::hash::pedersen_hash([node, 0]);
    }
    let merkle_root = node;
    let context: Field = 999;
    let nullifier = std::hash::pedersen_hash([secret, context]);

    main(
        secret,
        tier,
        path_elements,
        path_index,
        merkle_root,
        2, // tier_threshold <= tier(3)
        context,
        nullifier,
    );
}

#[test(should_fail_with = "Tier below threshold")]
fn test_tier_below_threshold_fails() {
    let secret: Field = 42;
    let tier: Field = 1; // tier = 1, threshold = 3 -> fail
    let leaf = std::hash::pedersen_hash([secret, tier]);

    let path_elements: [Field; 20] = [0; 20];
    let path_index: [u1; 20] = [0; 20];

    let mut node = leaf;
    for _i in 0..20 {
        node = std::hash::pedersen_hash([node, 0]);
    }
    let merkle_root = node;
    let context: Field = 1;
    let nullifier = std::hash::pedersen_hash([secret, context]);

    main(secret, tier, path_elements, path_index, merkle_root, 3, context, nullifier);
}

#[test(should_fail_with = "Merkle proof invalid")]
fn test_wrong_root_fails() {
    let secret: Field = 42;
    let tier: Field = 3;
    let path_elements: [Field; 20] = [0; 20];
    let path_index: [u1; 20] = [0; 20];
    let wrong_root: Field = 12345;
    let context: Field = 1;
    let nullifier = std::hash::pedersen_hash([secret, context]);

    main(secret, tier, path_elements, path_index, wrong_root, 2, context, nullifier);
}

#[test(should_fail_with = "Nullifier mismatch")]
fn test_wrong_nullifier_fails() {
    let secret: Field = 42;
    let tier: Field = 3;
    let leaf = std::hash::pedersen_hash([secret, tier]);
    let path_elements: [Field; 20] = [0; 20];
    let path_index: [u1; 20] = [0; 20];

    let mut node = leaf;
    for _i in 0..20 {
        node = std::hash::pedersen_hash([node, 0]);
    }
    let merkle_root = node;
    let context: Field = 1;
    let wrong_nullifier: Field = 9999;

    main(secret, tier, path_elements, path_index, merkle_root, 2, context, wrong_nullifier);
}
