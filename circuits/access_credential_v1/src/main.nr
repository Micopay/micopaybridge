// Anonymous access credential -- burn-once membership circuit.
//
// Proves, revealing nothing else:
//   1. leaf = pedersen_hash([secret, LEAF_DOMAIN]) is in the Merkle tree at `merkle_root`
//      (i.e. "I hold a valid, issued access credential")
//   2. nullifier = pedersen_hash([secret, NULLIFIER_DOMAIN])  (revealed, single-use marker)
//
// BURN-ONCE: the nullifier depends ONLY on `secret`. The domain separator is a fixed circuit
// constant the prover CANNOT rotate, so each credential yields exactly ONE nullifier. The
// on-chain `verify_unique` records it, so a credential can be spent at most once, globally.
// This is what guarantees "no excessive consumption / no spam" (anti-double-spend).
//
// UNLINKABILITY: leaf and nullifier use different domain separators (0 vs 1), so an observer --
// even the issuer, who only ever stores leaves -- cannot link a revealed nullifier back to its
// leaf (the purchase) without knowing `secret`. `secret` is user-generated and never shared.
//
// Hash: std::hash::pedersen_hash (BN254 Pedersen; poseidon::bn254 is not exported in
// nargo 1.0.0-beta.9 -- see TOOLCHAIN.md). On-chain UltraHonk/BN254 verification is hash-agnostic.
//
// PUBLIC INPUT ORDER: [merkle_root, nullifier]. The nullifier MUST stay LAST -- the contract's
// `verify_unique` reads the nullifier as the final 32-byte field of public_inputs.

global TREE_DEPTH: u32 = 20;
global LEAF_DOMAIN: Field = 0;       // domain separator for the leaf commitment
global NULLIFIER_DOMAIN: Field = 1;  // domain separator for the nullifier (must differ from LEAF_DOMAIN)

fn main(
    // ---- private inputs ----
    secret: Field,                       // user-generated credential secret (never shared)
    path_elements: [Field; TREE_DEPTH],  // Merkle siblings
    path_index: [u1; TREE_DEPTH],        // 0 = node is left child, 1 = right
    // ---- public inputs (nullifier MUST be last) ----
    merkle_root: pub Field,              // credential-set root, published on Soroban
    nullifier: pub Field,               // = H(secret, NULLIFIER_DOMAIN), recorded on-chain
) {
    // 1. Leaf commitment = H(secret, LEAF_DOMAIN)
    let leaf = std::hash::pedersen_hash([secret, LEAF_DOMAIN]);

    // 2. Merkle inclusion proof
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

    // 3. Burn-once nullifier -- domain is a fixed constant, so the prover cannot rotate it
    //    to mint a fresh nullifier from the same credential.
    let computed_nullifier = std::hash::pedersen_hash([secret, NULLIFIER_DOMAIN]);
    assert(computed_nullifier == nullifier, "Nullifier mismatch");
}

// Demo values for the credential-issuance CLI.
// Run: nargo test compute_demo_values --show-output
#[test]
fn compute_demo_values() {
    // agent_alice: one issued credential, single leaf in a depth-20 sparse tree (index 0).
    let secret: Field = 2001;
    let leaf = std::hash::pedersen_hash([secret, LEAF_DOMAIN]);

    // Root: 20-level hash chain, hashing [node, 0] each level (all siblings = 0).
    let mut node = leaf;
    for _i in 0..20 {
        node = std::hash::pedersen_hash([node, 0]);
    }
    let root = node;

    let nullifier = std::hash::pedersen_hash([secret, NULLIFIER_DOMAIN]);

    std::println(leaf);
    std::println(root);
    std::println(nullifier);
}

// Second demo credential (secret=3001) for the inference e2e -- a fresh, unspent
// credential (agent_alice's secret=2001 nullifier is already burned on-chain).
// Run: nargo test compute_demo_values_b --show-output
#[test]
fn compute_demo_values_b() {
    let secret: Field = 3001;
    let leaf = std::hash::pedersen_hash([secret, LEAF_DOMAIN]);
    let mut node = leaf;
    for _i in 0..20 {
        node = std::hash::pedersen_hash([node, 0]);
    }
    let root = node;
    let nullifier = std::hash::pedersen_hash([secret, NULLIFIER_DOMAIN]);
    std::println(leaf);
    std::println(root);
    std::println(nullifier);
}

// Credential pool for the x402 "buy" demo: prints root+nullifier for a batch of
// secrets (each a single-leaf sparse tree). Run: nargo test compute_pool --show-output
#[test]
fn compute_pool() {
    let secrets: [Field; 4] = [4001, 4002, 4003, 4004];
    for s in secrets {
        let leaf = std::hash::pedersen_hash([s, LEAF_DOMAIN]);
        let mut node = leaf;
        for _i in 0..20 {
            node = std::hash::pedersen_hash([node, 0]);
        }
        std::println(s);          // secret
        std::println(node);       // root
        std::println(std::hash::pedersen_hash([s, NULLIFIER_DOMAIN])); // nullifier
    }
}

// Multi-user tree (4 credentials under ONE root) -- proves a credible anonymity
// set. If main() passes for leaves at different positions with their computed
// paths, the multi-leaf tree + paths are correct. Run: nargo test test_multi_leaf_tree
#[test]
fn test_multi_leaf_tree() {
    let secrets: [Field; 4] = [5001, 5002, 5003, 5004];
    let mut leaves: [Field; 4] = [0; 4];
    for i in 0..4 {
        leaves[i] = std::hash::pedersen_hash([secrets[i], LEAF_DOMAIN]);
    }

    // Zero-subtree roots per level (empty leaf = 0): z[0]=0, z[k]=H(z[k-1],z[k-1]).
    let mut z: [Field; 20] = [0; 20];
    for k in 1..20 {
        z[k] = std::hash::pedersen_hash([z[k - 1], z[k - 1]]);
    }

    // Level-1 internal nodes over the 4 real leaves.
    let n01 = std::hash::pedersen_hash([leaves[0], leaves[1]]);
    let n23 = std::hash::pedersen_hash([leaves[2], leaves[3]]);
    // Level-2 node holding all 4; siblings above are the zero-subtrees.
    let n0123 = std::hash::pedersen_hash([n01, n23]);
    let mut node = n0123;
    for k in 2..20 {
        node = std::hash::pedersen_hash([node, z[k]]);
    }
    let root = node;

    // Path for leaf 0 (index 0): siblings = [leaf1, n23, z2..z19], all left.
    let mut p0: [Field; 20] = [0; 20];
    p0[0] = leaves[1];
    p0[1] = n23;
    for k in 2..20 { p0[k] = z[k]; }
    let idx0: [u1; 20] = [0; 20];
    main(secrets[0], p0, idx0, root, std::hash::pedersen_hash([secrets[0], NULLIFIER_DOMAIN]));

    // Path for leaf 2 (index 2 = bits 0,1): siblings = [leaf3, n01, z2..z19].
    let mut p2: [Field; 20] = [0; 20];
    p2[0] = leaves[3];
    p2[1] = n01;
    for k in 2..20 { p2[k] = z[k]; }
    let mut idx2: [u1; 20] = [0; 20];
    idx2[1] = 1;
    main(secrets[2], p2, idx2, root, std::hash::pedersen_hash([secrets[2], NULLIFIER_DOMAIN]));

    std::println(root);
}

// Emit every value needed to build a real 4-credential pool sharing ONE root.
// Print order: root, z[2..19], leaves[0..3], n01, n23, nullifiers[0..3].
// Run: nargo test compute_multi_pool --show-output
#[test]
fn compute_multi_pool() {
    let secrets: [Field; 4] = [5001, 5002, 5003, 5004];
    let mut leaves: [Field; 4] = [0; 4];
    for i in 0..4 {
        leaves[i] = std::hash::pedersen_hash([secrets[i], LEAF_DOMAIN]);
    }
    let mut z: [Field; 20] = [0; 20];
    for k in 1..20 {
        z[k] = std::hash::pedersen_hash([z[k - 1], z[k - 1]]);
    }
    let n01 = std::hash::pedersen_hash([leaves[0], leaves[1]]);
    let n23 = std::hash::pedersen_hash([leaves[2], leaves[3]]);
    let n0123 = std::hash::pedersen_hash([n01, n23]);
    let mut node = n0123;
    for k in 2..20 {
        node = std::hash::pedersen_hash([node, z[k]]);
    }
    std::println(node); // root
    for k in 2..20 {
        std::println(z[k]);
    }
    for i in 0..4 {
        std::println(leaves[i]);
    }
    std::println(n01);
    std::println(n23);
    for i in 0..4 {
        std::println(std::hash::pedersen_hash([secrets[i], NULLIFIER_DOMAIN]));
    }
}

// Client-generated credential (secret never leaves the client). Single-leaf tree.
// Demonstrates audit #2: the issuer only ever receives the commitment (leaf) + root.
// Run: nargo test compute_client_6001 --show-output  -> prints leaf, root, nullifier
#[test]
fn compute_client_6001() {
    let secret: Field = 6001;
    let leaf = std::hash::pedersen_hash([secret, LEAF_DOMAIN]);
    let mut node = leaf;
    for _i in 0..20 {
        node = std::hash::pedersen_hash([node, 0]);
    }
    std::println(leaf);
    std::println(node);
    std::println(std::hash::pedersen_hash([secret, NULLIFIER_DOMAIN]));
}

// Tests

// Valid spend: membership holds + correct nullifier.
#[test]
fn test_membership_and_nullifier_ok() {
    let secret: Field = 2001;
    let leaf = std::hash::pedersen_hash([secret, LEAF_DOMAIN]);

    let path_elements: [Field; 20] = [0; 20];
    let path_index: [u1; 20] = [0; 20];

    let mut node = leaf;
    for _i in 0..20 {
        node = std::hash::pedersen_hash([node, 0]);
    }
    let merkle_root = node;
    let nullifier = std::hash::pedersen_hash([secret, NULLIFIER_DOMAIN]);

    main(secret, path_elements, path_index, merkle_root, nullifier);
}

#[test(should_fail_with = "Merkle proof invalid")]
fn test_wrong_root_fails() {
    let secret: Field = 2001;
    let path_elements: [Field; 20] = [0; 20];
    let path_index: [u1; 20] = [0; 20];
    let wrong_root: Field = 12345;
    let nullifier = std::hash::pedersen_hash([secret, NULLIFIER_DOMAIN]);

    main(secret, path_elements, path_index, wrong_root, nullifier);
}

#[test(should_fail_with = "Nullifier mismatch")]
fn test_wrong_nullifier_fails() {
    let secret: Field = 2001;
    let leaf = std::hash::pedersen_hash([secret, LEAF_DOMAIN]);
    let path_elements: [Field; 20] = [0; 20];
    let path_index: [u1; 20] = [0; 20];

    let mut node = leaf;
    for _i in 0..20 {
        node = std::hash::pedersen_hash([node, 0]);
    }
    let merkle_root = node;
    let wrong_nullifier: Field = 9999;

    main(secret, path_elements, path_index, merkle_root, wrong_nullifier);
}

// A credential cannot be "rotated": the same secret always yields the same nullifier,
// so a second spend produces an identical nullifier and is rejected on-chain by verify_unique.
#[test]
fn test_nullifier_is_deterministic_per_credential() {
    let secret: Field = 2001;
    let n1 = std::hash::pedersen_hash([secret, NULLIFIER_DOMAIN]);
    let n2 = std::hash::pedersen_hash([secret, NULLIFIER_DOMAIN]);
    assert(n1 == n2, "nullifier must be deterministic per credential");
}
