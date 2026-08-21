import type { FastifyInstance } from "fastify";
import { isValidClassicAddress } from "xrpl";
import {
  createActivationPayload,
  createCancelPayload,
  getActivationPayloadStatus,
  getPendingCancelAfter,
  clearPendingCancelAfter,
  xummConfigured,
} from "../lib/xumm.js";
import { fetchTxSequence } from "../lib/xrpl-leg.js";
import { trackActivationEscrow } from "../lib/activationSweeper.js";

/**
 * Endpoint público (sin x402, sin login) para la estrategia de 300 cuentas
 * de Make Waves: arma la transacción y crea un payload de Xaman, el usuario
 * la firma escaneando el QR o abriendo el deep link con su propia wallet.
 * Ver docs/ESTRATEGIA_300_CUENTAS.md.
 *
 * A propósito NUNCA toca una seed ni firma nada — solo pide a Xaman que
 * arme el payload y luego pregunta su estado. Firmar aquí sería exactamente
 * el "scripted transactions" que el T&C prohíbe (§7).
 */
export async function activationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{
    Body: { account: string; amountXrp?: string; cancelAfterSeconds?: number };
  }>(
    "/api/v1/xrpl/activation/payload",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      if (!xummConfigured()) {
        return reply.status(503).send({
          error: "Xaman no está configurado (XUMM_API_KEY/XUMM_API_SECRET) — pide credenciales en apps.xaman.dev",
        });
      }

      const { account, amountXrp, cancelAfterSeconds } = request.body ?? {};
      if (typeof account !== "string" || !isValidClassicAddress(account)) {
        return reply.status(400).send({ error: "account debe ser una dirección XRPL válida — es tu propia dirección, se autobloquea a sí misma" });
      }

      const amount = amountXrp ?? "1";
      const amountNum = Number(amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0 || amountNum > 50) {
        return reply.status(400).send({ error: "amountXrp debe ser un número entre 0 y 50" });
      }
      if (
        cancelAfterSeconds !== undefined &&
        (!Number.isInteger(cancelAfterSeconds) || cancelAfterSeconds < 60 || cancelAfterSeconds > 86400)
      ) {
        return reply.status(400).send({ error: "cancelAfterSeconds debe estar entre 60 y 86400" });
      }

      try {
        const payload = await createActivationPayload({ accountAddress: account, amountXrp: amount, cancelAfterSeconds });
        return reply.send(payload);
      } catch (err) {
        request.log.error(err, "activation/payload falló");
        return reply.status(502).send({ error: "no se pudo crear el payload de Xaman — reintenta" });
      }
    },
  );

  fastify.post<{
    Body: { txid: string };
  }>(
    "/api/v1/xrpl/activation/reclaim",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      if (!xummConfigured()) {
        return reply.status(503).send({ error: "Xaman no está configurado" });
      }

      const { txid } = request.body ?? {};
      if (typeof txid !== "string" || txid.length < 10) {
        return reply.status(400).send({ error: "txid inválido — es el hash de tu EscrowCreate ya firmado" });
      }

      try {
        const seq = await fetchTxSequence(txid);
        if (!seq) {
          return reply.status(404).send({ error: "no se encontró esa transacción en el ledger todavía — espera a que confirme" });
        }
        const payload = await createCancelPayload({ owner: seq.account, offerSequence: seq.sequence });
        return reply.send(payload);
      } catch (err) {
        request.log.error(err, "activation/reclaim falló");
        return reply.status(502).send({ error: "no se pudo armar el reclamo — reintenta" });
      }
    },
  );

  fastify.get<{ Params: { uuid: string } }>(
    "/api/v1/xrpl/activation/payload/:uuid",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      if (!xummConfigured()) {
        return reply.status(503).send({ error: "Xaman no está configurado" });
      }
      try {
        const status = await getActivationPayloadStatus(request.params.uuid);

        if (status.signed && status.txid && status.account && status.dispatchedResult === "tesSUCCESS") {
          const cancelAfter = getPendingCancelAfter(request.params.uuid);
          if (cancelAfter !== undefined) {
            // Solo se registra una vez: en cuanto se limpia el pendiente,
            // pollear de nuevo ya no vuelve a golpear el ledger por el Sequence.
            clearPendingCancelAfter(request.params.uuid);
            fetchTxSequence(status.txid)
              .then((seq) => {
                if (!seq) {
                  request.log.warn(`no se encontró Sequence para ${status.txid} — el sweeper no podrá cancelarlo solo`);
                  return;
                }
                trackActivationEscrow({
                  owner: seq.account,
                  offerSequence: seq.sequence,
                  cancelAfterRipple: cancelAfter,
                });
              })
              .catch((err) => request.log.error(err, "no se pudo registrar el escrow en el sweeper"));
          }
        }

        return reply.send(status);
      } catch (err) {
        request.log.error(err, "activation/payload status falló");
        return reply.status(404).send({ error: "payload no encontrado o expirado" });
      }
    },
  );
}
