import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import {
  CIRCUIT_SPECS,
  ROOTED_CIRCUITS,
  NULLIFIER_CIRCUITS,
  invokeVerify,
  fetchReputationRoot,
  NullifierAlreadyUsedError,
} from "../lib/zkVerify.js";

// The resource consumed: Claude inference. Mirrors the Anthropic usage in agent.ts.
const MODEL = process.env.INFERENCE_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;

interface InferenceBody {
  circuit_id?: string; // defaults to access_credential_v1
  proof: string; // base64-encoded UltraHonk proof
  public_inputs: string[]; // BN254 field elements as decimal strings
  prompt: string;
  max_tokens?: number;
}

export async function inferenceRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/inference
   *
   * Consume a resource (Claude inference) by SPENDING an anonymous access
   * credential — no x402 payment here: the credential IS the prepaid access,
   * bought earlier via x402 (see /api/v1/credentials/buy). This is the spend
   * leg of the pipeline: prove (ZK) you hold a valid, unspent credential
   * WITHOUT revealing who you are or which one; the contract burns its
   * nullifier so it can be used at most once.
   *
   * Body:
   *   circuit_id?:   defaults to "access_credential_v1"
   *   proof:         base64 UltraHonk proof
   *   public_inputs: [merkle_root, nullifier] as decimal strings
   *   prompt:        the inference request
   */
  fastify.post<{ Body: InferenceBody }>(
    "/api/v1/inference",
    async (request, reply) => {
      const body = request.body ?? ({} as InferenceBody);
      const circuit_id = body.circuit_id ?? "access_credential_v1";
      const { proof, public_inputs, prompt } = body;

      // 1. Validate inputs
      if (!proof || !Array.isArray(public_inputs) || !prompt) {
        return reply.status(400).send({
          error: "Missing fields",
          required: ["proof", "public_inputs", "prompt"],
        });
      }
      const spec = CIRCUIT_SPECS[circuit_id];
      if (!spec || !NULLIFIER_CIRCUITS.has(circuit_id)) {
        return reply.status(400).send({
          error: "circuit_id must be a credential circuit (carries a nullifier)",
          valid: [...NULLIFIER_CIRCUITS],
        });
      }
      if (public_inputs.length !== spec.numInputs) {
        return reply.status(400).send({
          error: `circuit '${circuit_id}' expects ${spec.numInputs} public_inputs`,
          received: public_inputs.length,
        });
      }
      if (!public_inputs.every((v) => /^\d+$/.test(v))) {
        return reply
          .status(400)
          .send({ error: "public_inputs must be decimal integer strings" });
      }
      let proofBuf: Buffer;
      try {
        proofBuf = Buffer.from(proof, "base64");
        if (proofBuf.length === 0) throw new Error("empty");
      } catch {
        return reply.status(400).send({ error: "proof must be valid base64" });
      }

      // 2. Resource availability (the model gateway)
      if (!process.env.ANTHROPIC_API_KEY) {
        return reply
          .status(503)
          .send({ error: "Inference not configured — ANTHROPIC_API_KEY missing" });
      }

      // 3. Cross-check the credential-set root against the on-chain root, so a
      //    prover can't use a fabricated root with their own leaf.
      //    SEC-C4 (mirrors SEC-08 in routes/zk.ts): RPC failure is FATAL — a
      //    silently-skipped root check opens a window where an attacker can
      //    submit a proof with a fabricated root while the RPC is unreachable.
      //    This is the route that actually serves the resource, so it's the
      //    one that matters — reject with 503 instead of letting the proof through.
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

      // 4. SPEND the credential: verify the proof AND burn its nullifier on-chain.
      let verified: boolean;
      let verifyTxHash: string;
      try {
        ({ verified, txHash: verifyTxHash } = await invokeVerify(circuit_id, proofBuf, public_inputs));
      } catch (err) {
        if (err instanceof NullifierAlreadyUsedError) {
          return reply.status(409).send({
            error: "Credential already spent — this credential has been used before",
          });
        }
        const msg = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err }, "Credential verification failed");
        return reply
          .status(502)
          .send({ error: "Credential verification call failed", detail: msg });
      }
      if (!verified) {
        return reply
          .status(403)
          .send({ error: "Invalid credential — proof did not verify" });
      }

      // 5. Credential valid + freshly burned → serve the resource (Claude).
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: MODEL,
          max_tokens: body.max_tokens ?? MAX_TOKENS,
          messages: [{ role: "user", content: prompt }],
        });
        const completion = msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");

        return reply.send({
          completion,
          model: MODEL,
          credential_spent: true,
          verify_tx_hash: verifyTxHash,
          usage: msg.usage,
        });
      } catch (err) {
        // The credential is already burned on-chain at this point. Surface the
        // error honestly; a production system would refund/credit the nullifier.
        fastify.log.error({ err }, "Inference call failed after credential burn");
        return reply.status(502).send({
          error: "Inference failed after credential was spent",
          detail: err instanceof Error ? err.message : String(err),
          credential_spent: true,
        });
      }
    }
  );
}
