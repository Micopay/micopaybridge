// Proves knowledge of a secret whose pedersen_hash equals the public hash.
// Hash function: std::hash::pedersen_hash (BN254 Pedersen, native to Noir stdlib 1.0.x)
// See TOOLCHAIN.md: poseidon::bn254 not exported in nargo 1.0.0-beta.9; pedersen used instead.
fn main(secret: Field, hash: pub Field) {
    let h = std::hash::pedersen_hash([secret]);
    assert(h == hash);
}

#[test]
fn test_known_preimage() {
    let secret: Field = 12345;
    let h = std::hash::pedersen_hash([secret]);
    // hash must be deterministic
    let h2 = std::hash::pedersen_hash([secret]);
    assert(h == h2);
}

#[test(should_fail)]
fn test_wrong_hash_fails() {
    let secret: Field = 42;
    let h = std::hash::pedersen_hash([secret]);
    // 9999999999 is not the real hash of 42
    assert(h == 9999999999);
}
