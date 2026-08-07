#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracterror, symbol_short,
    Address, Bytes, Env, Map, Symbol,
};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, VkLoadError};

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const VK_MAP_KEY: Symbol = symbol_short!("VK_MAP");
const ROOT_KEY: Symbol = symbol_short!("REP_ROOT");

// WP 0.7: nullifiers are meant to be burn-once FOREVER, but Soroban persistent
// entries still expire without periodic TTL extension — there is no way to
// mark an entry as permanently alive in a single call. The network caps any
// one extend_ttl at `state_archival.max_entry_ttl` ledgers from now (confirmed
// via `stellar network settings` against testnet: 3,110,400 ledgers, ~180 days
// at the 5s target ledger close time). The previous 200_000-ledger extend_to
// (~11.6 days) meant a burned credential's replay protection could lapse in
// under two weeks unless something re-extended it. Use the network's actual
// per-call ceiling, and expose `refresh_nullifier` (below) so an off-chain
// keeper can top it back up before it lapses.
const NULLIFIER_TTL_MAX: u32 = 3_110_400;
const NULLIFIER_TTL_THRESHOLD: u32 = NULLIFIER_TTL_MAX / 2;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ZkError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    UnknownCircuit = 4,
    VkInvalidLength = 5,
    VkInvalidParameters = 6,
    ProofParseError = 7,
    VerificationFailed = 8,
    ReputationRootNotSet = 9,
    NullifierAlreadyUsed = 10,
    UnknownNullifier = 11,
}

#[contract]
pub struct ZkVerifierRegistry;

#[contractimpl]
impl ZkVerifierRegistry {
    /// Initialize the registry. Can only be called once.
    pub fn init(env: Env, admin: Address) -> Result<(), ZkError> {
        if env.storage().instance().has(&ADMIN_KEY) {
            return Err(ZkError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN_KEY, &admin);
        Ok(())
    }

    /// Register a verification key for a circuit. Admin only.
    /// circuit_id: Symbol like "poseidon_preimage" or "reputation_v1"
    /// vk: raw VK bytes from `bb write_vk`
    pub fn register_circuit(env: Env, circuit_id: Symbol, vk: Bytes) -> Result<(), ZkError> {
        Self::require_admin(&env)?;

        // Validate VK bytes parse correctly before storing
        UltraHonkVerifier::new(&env, &vk).map_err(|e| match e {
            VkLoadError::WrongLength => ZkError::VkInvalidLength,
            VkLoadError::InvalidParameters => ZkError::VkInvalidParameters,
        })?;

        let mut map: Map<Symbol, Bytes> = env
            .storage()
            .instance()
            .get(&VK_MAP_KEY)
            .unwrap_or_else(|| Map::new(&env));

        map.set(circuit_id, vk);
        env.storage().instance().set(&VK_MAP_KEY, &map);
        Ok(())
    }

    /// Set the on-chain reputation Merkle root. Admin only.
    pub fn set_reputation_root(env: Env, root: Bytes) -> Result<(), ZkError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&ROOT_KEY, &root);
        Ok(())
    }

    /// Get the current reputation Merkle root.
    pub fn get_reputation_root(env: Env) -> Result<Bytes, ZkError> {
        env.storage()
            .instance()
            .get(&ROOT_KEY)
            .ok_or(ZkError::ReputationRootNotSet)
    }

    /// Verify an UltraHonk proof for the given circuit.
    ///
    /// circuit_id:    Symbol matching a registered VK
    /// public_inputs: raw public input bytes (field elements, 32 bytes each, big-endian)
    /// proof:         raw UltraHonk proof bytes (PROOF_BYTES = 456 * 32 = 14592)
    ///
    /// Returns Ok(()) if valid, Err(VerificationFailed) otherwise.
    pub fn verify(
        env: Env,
        circuit_id: Symbol,
        public_inputs: Bytes,
        proof: Bytes,
    ) -> Result<(), ZkError> {
        let vk = Self::get_vk(&env, &circuit_id)?;
        let verifier = UltraHonkVerifier::new(&env, &vk).map_err(|e| match e {
            VkLoadError::WrongLength => ZkError::VkInvalidLength,
            VkLoadError::InvalidParameters => ZkError::VkInvalidParameters,
        })?;
        verifier
            .verify(&env, &proof, &public_inputs)
            .map_err(|_| ZkError::VerificationFailed)
    }

    /// Verify a proof AND record its nullifier to prevent replay (burn-once).
    ///
    /// Convention: the nullifier is the LAST public input (final 32 bytes of
    /// `public_inputs`, 32 bytes per BN254 field). This holds for every circuit
    /// whose last public input is the nullifier, e.g.:
    ///   - reputation_v1        [merkle_root, tier_threshold, context, nullifier] (128 bytes -> [96..128])
    ///   - access_credential_v1 [merkle_root, nullifier]                          (64 bytes  -> [32..64])
    /// A nullifier can only be used once per ZkVerifierRegistry instance, so a
    /// credential whose nullifier is deterministic (e.g. access_credential_v1's
    /// H(secret, DOMAIN)) can be spent at most once -> anti-double-spend / anti-spam.
    ///
    /// Use this instead of `verify` for circuits that carry a nullifier field.
    pub fn verify_unique(
        env: Env,
        circuit_id: Symbol,
        public_inputs: Bytes,
        proof: Bytes,
    ) -> Result<(), ZkError> {
        // Extract the nullifier (last 32 bytes) before verification so a bad
        // proof cannot sneak a nullifier into the used set.
        let len = public_inputs.len();
        if len < 32 {
            return Err(ZkError::ProofParseError);
        }
        let offset = len - 32;
        let mut nullifier_arr = [0u8; 32];
        for i in 0..32u32 {
            nullifier_arr[i as usize] = public_inputs.get(offset + i).unwrap_or(0);
        }
        let nullifier = Bytes::from_array(&env, &nullifier_arr);

        // Reject replayed nullifiers before doing expensive crypto
        if env.storage().persistent().has(&nullifier) {
            return Err(ZkError::NullifierAlreadyUsed);
        }

        // Run the full UltraHonk verification
        let vk = Self::get_vk(&env, &circuit_id)?;
        let verifier = UltraHonkVerifier::new(&env, &vk).map_err(|e| match e {
            VkLoadError::WrongLength => ZkError::VkInvalidLength,
            VkLoadError::InvalidParameters => ZkError::VkInvalidParameters,
        })?;
        verifier
            .verify(&env, &proof, &public_inputs)
            .map_err(|_| ZkError::VerificationFailed)?;

        // Record nullifier only after proof is valid
        env.storage().persistent().set(&nullifier, &true);
        env.storage()
            .persistent()
            .extend_ttl(&nullifier, NULLIFIER_TTL_THRESHOLD, NULLIFIER_TTL_MAX);

        Ok(())
    }

    /// Keeper hook: re-extend a nullifier's TTL before it lapses. Permissionless
    /// — extending TTL only pays rent to keep the burn-once record alive, it
    /// cannot forge, clear, or otherwise affect which nullifiers are recorded.
    /// A single extend_ttl call can only reach NULLIFIER_TTL_MAX ledgers into
    /// the future (the network's max_entry_ttl), so an off-chain keeper should
    /// call this periodically for nullifiers recorded via `verify_unique`
    /// before their current TTL window runs out.
    pub fn refresh_nullifier(env: Env, nullifier: Bytes) -> Result<(), ZkError> {
        if !env.storage().persistent().has(&nullifier) {
            return Err(ZkError::UnknownNullifier);
        }
        env.storage()
            .persistent()
            .extend_ttl(&nullifier, NULLIFIER_TTL_THRESHOLD, NULLIFIER_TTL_MAX);
        Ok(())
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), ZkError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(ZkError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn get_vk(env: &Env, circuit_id: &Symbol) -> Result<Bytes, ZkError> {
        let map: Map<Symbol, Bytes> = env
            .storage()
            .instance()
            .get(&VK_MAP_KEY)
            .ok_or(ZkError::UnknownCircuit)?;
        map.get(circuit_id.clone()).ok_or(ZkError::UnknownCircuit)
    }
}

#[cfg(test)]
mod test;
