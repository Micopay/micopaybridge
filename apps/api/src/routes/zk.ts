import type { FastifyInstance } from "fastify";
import { requirePayment } from "../middleware/x402.js";
import {
  CIRCUIT_SPECS,
  ROOTED_CIRCUITS,
  invokeVerify,
  fetchReputationRoot,
  NullifierAlreadyUsedError,
} from "../lib/zkVerify.js";

interface ZkVerifyBody {
  circuit_id: string;
  proof: string; // base64-encoded UltraHonk proof
  public_inputs: string[]; // BN254 field elements as decimal strings
}

export async function zkRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/zk/verify
   *
   * Pay-per-use ZK proof verification.
   * Client pays 0.001 USDC via x402, submits proof + public_inputs,
   * gets { verified: true/false }.
   *
   * Body:
   *   circuit_id:    "poseidon_preimage" | "reputation_v1"
   *   proof:         base64-encoded UltraHonk proof bytes
   *   public_inputs: BN254 field elements as decimal strings
   *
   * For reputation_v1, public_inputs[0] (merkle_root) is validated
   * against the current on-chain root before forwarding to the contract.
   */
  fastify.post<{ Body: ZkVerifyBody }>(
    "/api/v1/zk/verify",
    { preHandler: requirePayment({ amount: "0.001", service: "zk_verify" }) },
    async (request, reply) => {
      const { circuit_id, proof, public_inputs } = request.body ?? {};

      // 1. Validate presence
      if (!circuit_id || !proof || !Array.isArray(public_inputs)) {
        return reply.status(400).send({
          error: "Missing fields",
          required: ["circuit_id", "proof", "public_inputs"],
        });
      }

      // 2. Validate circuit_id
      const spec = CIRCUIT_SPECS[circuit_id];
      if (!spec) {
        return reply.status(400).send({
          error: "Unknown circuit_id",
          valid: Object.keys(CIRCUIT_SPECS),
        });
      }

      // 3. Validate public_inputs shape
      if (public_inputs.length !== spec.numInputs) {
        return reply.status(400).send({
          error: `circuit '${circuit_id}' expects exactly ${spec.numInputs} public_inputs`,
          received: public_inputs.length,
        });
      }

      // 4. Validate each field element is a decimal integer string
      for (const v of public_inputs) {
        if (!/^\d+$/.test(v)) {
          return reply.status(400).send({
            error: "public_inputs must be decimal integer strings",
            invalid: v,
          });
        }
      }

      // 5. Decode proof
      let proofBuf: Buffer;
      try {
        proofBuf = Buffer.from(proof, "base64");
        if (proofBuf.length === 0) throw new Error("empty");
      } catch {
        return reply.status(400).send({ error: "proof must be valid base64" });
      }

      // 6. For rooted circuits: cross-check public_inputs[0] (merkle_root) against
      //    the published on-chain root so a prover can't use a fabricated root.
      //    SEC-08: RPC failure is FATAL — a silently-skipped root check opens a
      //    window where an attacker can submit a proof with a fabricated root while
      //    the RPC is unreachable. Reject with 503 instead of letting the proof through.
      if (ROOTED_CIRCUITS.has(circuit_id)) {
        try {
          const onChainRoot = await fetchReputationRoot();
          // fetchReputationRoot() returns null (not a throw) for missing
          // config, RPC simulation errors, and unreadable return values — all
          // of those must fail closed too, not just thrown exceptions.
          if (!onChainRoot) {
            throw new Error("on-chain root unavailable (null return)");
          }
          if (public_inputs[0] !== onChainRoot) {
            return reply.status(400).send({
              error: "public_inputs[0] (merkle_root) does not match on-chain root",
              on_chain_root: onChainRoot,
            });
          }
        } catch (err) {
          fastify.log.error({ err }, "Could not fetch on-chain root — rejecting request to prevent fabricated-root attack");
          return reply.status(503).send({
            error: "Cannot verify Merkle root: on-chain root unavailable. Try again later.",
          });
        }
      }

      // 7. Invoke contract
      try {
        const { verified, txHash } = await invokeVerify(circuit_id, proofBuf, public_inputs);
        return reply.send({
          verified,
          circuit_id,
          tx_hash: txHash,
          payer: (request as typeof request & { payerAddress?: string }).payerAddress,
        });
      } catch (err) {
        if (err instanceof NullifierAlreadyUsedError) {
          return reply.status(409).send({
            error: "Nullifier already used — this proof has already been verified in this context",
          });
        }
        const msg = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err }, "ZK verification failed");
        return reply.status(502).send({
          error: "Verification call failed",
          detail: msg,
        });
      }
    }
  );

  /**
   * GET /api/v1/zk/circuits
   * Public. Lists available circuits and expected input shapes.
   */
  fastify.get("/api/v1/zk/circuits", async (_req, reply) => {
    return reply.send({
      circuits: Object.entries(CIRCUIT_SPECS).map(([id, spec]) => ({
        circuit_id: id,
        num_public_inputs: spec.numInputs,
      })),
      payment: {
        amount_usdc: "0.001",
        endpoint: "POST /api/v1/zk/verify",
      },
    });
  });
}
