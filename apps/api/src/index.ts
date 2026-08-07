import "./config.js";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyJwt from "@fastify/jwt";
import { registerRateLimit } from "./plugins/rate-limit.js";
import { healthRoutes } from "./routes/health.js";
import { reputationRoutes } from "./routes/reputation.js";
import { serviceRoutes } from "./routes/services.js";
import { demoRoutes } from "./routes/demo.js";
import { zkRoutes } from "./routes/zk.js";
import { inferenceRoutes } from "./routes/inference.js";
import { credentialRoutes } from "./routes/credentials.js";
import { bazaarRoutes } from "./routes/bazaar.js";
import { agentRoutes } from "./routes/agent.js";
import { swapRoutes } from "./routes/swaps.js";
import { recoverInFlightSwaps, startRefundRetryLoop } from "./lib/recovery.js";
import { pendingRefunds } from "./lib/swapStore.js";
import { config } from "./config.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const NODE_ENV = process.env.NODE_ENV ?? "development";

if (process.env.X402_MOCK_MODE === "true" && NODE_ENV === "production") {
  throw new Error("X402_MOCK_MODE=true is not allowed in production — it bypasses all payment validation");
}

if (process.env.ALLOW_CLIENT_ROOTS === "true" && NODE_ENV === "production") {
  throw new Error("ALLOW_CLIENT_ROOTS=true is not allowed in production — it lets any payer overwrite the shared credential pool's trust anchor");
}

/**
 * Configure CORS based on environment and allowed origins.
 * Development: allows localhost and 127.0.0.1
 * Production: requires explicit CORS_ALLOWED_ORIGINS configuration
 */
function getCorsOptions() {
  const origins = config.corsAllowedOrigins;

  if (origins.length === 0) {
    // Fail-safe: if no origins configured in production, reject all CORS
    if (NODE_ENV === "production") {
      console.warn("[SECURITY] No CORS origins configured in production. CORS requests will be rejected.");
      return {
        origin: false,
        credentials: false,
      };
    }
    // Development with no explicit config: use defaults
    return {
      origin: true,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    };
  }

  // Specific origins configured
  return {
    origin: origins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400, // 24 hours
  };
}

export async function createApp() {
  const app = Fastify({
    logger: NODE_ENV === "development",
    trustProxy: true,
  });

  // Register security headers via @fastify/helmet
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://soroban-testnet.stellar.org", "https://soroban.stellar.org"],
      },
    },
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin",
    },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    frameguard: {
      action: "deny",
    },
    noSniff: true,
    xssFilter: true,
  });

  // Register CORS with secure configuration
  app.register(fastifyCors, getCorsOptions());

  app.register(fastifyJwt, { secret: config.jwtSecret });

  registerRateLimit(app);

  // Las rutas retail (auth, users, cash, fund, cetes, blend, kyc, ramp,
  // merchants, trade-messages, trades, stellar) se quedaron en
  // micopay-protocol: su versión viva es micopay/backend. Ver §3.2 del plan
  // de split.
  //
  // agent.ts y swaps.ts llevaban sin registrar desde el origen: el plan y el
  // ejecutor del swap existían pero no eran alcanzables por HTTP. Se cablean
  // en M4.5, porque el entregable es el flujo lock → reveal → claim de punta
  // a punta y sin esto no hay punta.
  app.register(healthRoutes);
  app.register(agentRoutes);
  app.register(swapRoutes);
  app.register(reputationRoutes);
  app.register(serviceRoutes);
  app.register(demoRoutes);
  app.register(bazaarRoutes);
  app.register(zkRoutes);
  app.register(inferenceRoutes);
  app.register(credentialRoutes);

  return app;
}

/**
 * Un swap a medias no se arregla solo. Al arrancar se revisa contra las
 * cadenas qué quedó abierto: lo que se reveló antes del crash se completa
 * recuperando la preimagen del ledger, y lo que no, se reembolsa. Los que aún
 * no han vencido quedan en el reintento periódico.
 *
 * No bloquea el arranque ni lo tumba: si esto falla, la API tiene que seguir
 * atendiendo, pero el fallo se ve en el log.
 */
async function arrancarRecuperacion() {
  const initiatorSecret = process.env.PLATFORM_SECRET_KEY;
  const counterpartySecret = process.env.DEMO_AGENT_SECRET_KEY;
  const initiatorSeed = process.env.XRPL_INITIATOR_SEED;
  const counterpartySeed = process.env.XRPL_COUNTERPARTY_SEED;

  if (!initiatorSecret || !counterpartySecret || !initiatorSeed || !counterpartySeed) {
    const colgados = pendingRefunds().length;
    console.warn(
      `[recovery] llaves de demo sin configurar: no se revisan swaps a medias` +
      (colgados > 0 ? ` — HAY ${colgados} CON FONDOS BLOQUEADOS` : "")
    );
    return;
  }

  const config = {
    initiatorSecret,
    counterpartySecret,
    contractA: process.env.ATOMIC_SWAP_CONTRACT_A ?? "CCDOUXIXSFXT2HTJAJGFNUJN6CKCYX2M6AL2BHHPEF6ISNHP2BGLS4KX",
    xrplLeg: { initiatorSeed, counterpartySeed },
  };

  try {
    await recoverInFlightSwaps(config);
  } catch (err) {
    console.error("[recovery] falló la revisión de arranque:", err);
  }
  startRefundRetryLoop(config);
}

async function start() {
  const app = await createApp();
  await arrancarRecuperacion();

  // Log security configuration on startup
  console.log(`[SECURITY] NODE_ENV: ${NODE_ENV}`);
  console.log(`[SECURITY] CORS Allowed Origins: ${config.corsAllowedOrigins.length > 0 ? config.corsAllowedOrigins.join(", ") : "NONE (all CORS requests rejected)"}`);
  console.log(`[SECURITY] Security Headers: Helmet enabled with CSP, HSTS, X-Frame-Options, X-Content-Type-Options`);
  
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`MicoPay API running on http://localhost:${PORT}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start();
}
