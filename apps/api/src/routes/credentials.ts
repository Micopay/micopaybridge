import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requirePayment } from "../middleware/x402.js";
import { setReputationRoot, fetchReputationRoot } from "../lib/zkVerify.js";

interface Credential {
  secret: string;
  merkle_root: string;
  nullifier: string;
  path_elements: string[]; // 20 Merkle siblings (hex)
  path_index: number[]; // 20 left/right bits
  circuit_id: string;
}

// DEMO pool: N credentials sharing ONE Merkle root (anonymity set = N), each
// carrying its real Merkle path. The shared root is published ONCE, so every
// credential is valid simultaneously. Production: the client generates the secret
// and the issuer only ever sees the commitment H(secret) — full unlinkability.
const __filename = fileURLToPath(import.meta.url);
const POOL_PATH = join(dirname(__filename), "..", "..", "demo", "credential_pool.json");
const POOL_DATA = JSON.parse(readFileSync(POOL_PATH, "utf8")) as {
  merkle_root: string;
  credentials: Credential[];
};
const SHARED_ROOT = POOL_DATA.merkle_root;
const POOL = POOL_DATA.credentials;
const allocated = new Set<number>();

export async function credentialRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/credentials/buy
   *
   * The BUY leg of the pipeline (x402). Pay USDC -> receive an anonymous access
   * credential. The payment is PUBLIC (a payment has nothing to hide). The
   * credential is later SPENT privately at /api/v1/inference (ZK proof +
   * nullifier burn), unlinkable to this purchase.
   *
   * x402: 0.01 USDC per credential (mock-accepted in dev).
   */
  fastify.post(
    "/api/v1/credentials/buy",
    { preHandler: requirePayment({ amount: "0.01", service: "credential_buy" }) },
    async (request, reply) => {
      // ── Mode A: CLIENT-GENERATED commitment (audit #2, full unlinkability) ──
      // The client generated the secret locally and sends ONLY the commitment
      // H(secret) (+ the root of the tree it belongs to). The issuer NEVER sees
      // the secret -> it can't link this purchase to any future spend.
      const body = (request.body ?? {}) as {
        commitment?: string;
        merkle_root?: string;
      };
      if (body.commitment && body.merkle_root) {
        // WP 0.4 (root governance): the contract has ONE global root slot,
        // shared with Mode B's pool. Publishing `body.merkle_root` as-is means
        // ANY paying client can overwrite that slot with a root for a tree
        // they fully control — hijacking the trust anchor Mode B depends on,
        // then self-issuing unlimited valid-looking credentials for the price
        // of one purchase. The real fix (server-side batch-anchoring of
        // collected commitments into one tree it builds itself, or a
        // multi-root contract) needs a Pedersen/Merkle engine ported to TS —
        // none exists here today; tree construction is currently offline-only
        // via `nargo test compute_demo_values`. Until that lands, refuse to
        // self-service publish a client-dictated root unless explicitly
        // opted into for demo/dev use.
        if (!(process.env.ALLOW_CLIENT_ROOTS === "true" && process.env.NODE_ENV !== "production")) {
          return reply.status(403).send({
            error:
              "Client-generated roots are disabled (set ALLOW_CLIENT_ROOTS=true outside production). " +
              "Publishing an unvalidated client root would let any payer hijack the shared credential pool's trust anchor.",
          });
        }
        let tx: string | null = null;
        try {
          const current = await fetchReputationRoot();
          if (current !== body.merkle_root) {
            tx = await setReputationRoot(body.merkle_root);
          }
        } catch (err) {
          return reply.status(502).send({
            error: "Failed to anchor the client's credential root",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        return reply.send({
          bought: 1,
          mode: "client_generated",
          payer: request.payerAddress,
          commitment_received: body.commitment,
          anchored_root_tx: tx,
          issuer_knows_secret: false,
          note:
            "Full unlinkability: the issuer only ever received the commitment " +
            "H(secret), never the secret. Spend at /api/v1/inference with your " +
            "own secret + path. (Demo: single-leaf tree the client anchored; " +
            "multi-user + client-gen together = batch-anchor of collected commitments.)",
        });
      }

      // ── Mode B: server-minted pool (shared-root, anonymity set = N) ──
      // Allocate the next unused credential from the shared-root pool.
      const idx = POOL.findIndex((_, i) => !allocated.has(i));
      if (idx === -1) {
        return reply
          .status(503)
          .send({ error: "Credential pool exhausted (demo) — regenerate the pool" });
      }
      const cred = POOL[idx];
      allocated.add(idx);

      // Publish the shared root ONCE: only if the on-chain root isn't already it.
      // All pool credentials share this root, so subsequent buys are free.
      let activatedRootTx: string | null = null;
      try {
        const current = await fetchReputationRoot();
        if (current !== SHARED_ROOT) {
          activatedRootTx = await setReputationRoot(SHARED_ROOT);
        }
      } catch (err) {
        allocated.delete(idx); // roll back the allocation if activation failed
        return reply.status(502).send({
          error: "Failed to activate credential root on-chain",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      return reply.send({
        bought: 1,
        payer: request.payerAddress,
        credential: {
          secret: cred.secret,
          circuit_id: cred.circuit_id,
          public_inputs: [cred.merkle_root, cred.nullifier],
          path_elements: cred.path_elements,
          path_index: cred.path_index,
        },
        activated_root_tx: activatedRootTx, // null if the root was already live
        how_to_spend:
          "Build a Prover.toml with this secret + path_elements + path_index, " +
          "generate an access_credential_v1 proof, then POST /api/v1/inference " +
          "{ proof, public_inputs, prompt }. Single-use.",
        note:
          "DEMO: credential is server-minted. Production: the client generates the " +
          "secret; the issuer only ever sees the commitment H(secret) — full " +
          "unlinkability. Anonymity set = " + POOL.length + " (shared root).",
      });
    }
  );
}
