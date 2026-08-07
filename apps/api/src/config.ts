import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env file manually (no dotenv dependency needed)
function loadEnv() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, "..", ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

// Load .env file only in development if not in CI/Production
if (process.env.NODE_ENV !== "production") {
  loadEnv();
}

/**
 * Pure helper: derive demoMode from raw env values.
 * demoMode is true iff DEMO_MODE==="true" AND NODE_ENV!=="production".
 * When NODE_ENV=production and DEMO_MODE=true, the caller should log a warning.
 */
export function deriveDemoMode(
  demoModeEnv: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  return demoModeEnv === "true" && nodeEnv !== "production";
}

// Emit production-safety warning at module load time if applicable
if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE === "true") {
  console.warn("[WARN] DEMO_MODE=true is ignored in production");
}

/**
 * Parse CORS_ALLOWED_ORIGINS from environment variable.
 * Format: comma-separated list of origins (e.g., "https://example.com,https://app.example.com")
 * Defaults to localhost in development, empty array in production.
 */
function parseAllowedOrigins(originsEnv: string | undefined, nodeEnv: string | undefined): string[] {
  if (!originsEnv) {
    // Development: allow localhost
    if (nodeEnv !== "production") {
      return ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"];
    }
    // Production: empty array means no CORS (must be explicitly configured)
    return [];
  }
  return originsEnv.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0);
}

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl:
    process.env.DATABASE_URL || "postgresql://localhost:5432/micopay_dev",

  // Stellar
  stellarRpcUrl:
    process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
  stellarNetwork: process.env.STELLAR_NETWORK || "TESTNET",
  platformSecretKey: process.env.PLATFORM_SECRET_KEY || "",
  escrowContractId: process.env.ESCROW_CONTRACT_ID || "",
  mxneContractId: process.env.MXNE_CONTRACT_ID || "",
  mxneIssuerAddress: process.env.MXNE_ISSUER_ADDRESS || "",

  // HTLC Secret Encryption
  secretEncryptionKey: process.env.SECRET_ENCRYPTION_KEY || "",

  // JWT
  jwtSecret: process.env.JWT_SECRET || "dev_jwt_secret",
  jwtExpiry: process.env.JWT_EXPIRY || "24h",

  // CORS & Security
  corsAllowedOrigins: parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS, process.env.NODE_ENV),
  nodeEnv: process.env.NODE_ENV || "development",

  // MVP flags
  mockStellar: process.env.MOCK_STELLAR === "true",
  enableInvestments: process.env.ENABLE_INVESTMENTS === "true" || process.env.DEMO_MODE === "true",

  // Base (BASE_IMPLEMENTATION_PLAN_2026-07.md, WP1)
  x402AcceptChains: (process.env.X402_ACCEPT_CHAINS || "stellar")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
  baseRpcUrl: process.env.BASE_RPC_URL || "https://sepolia.base.org",
  baseChainId: parseInt(process.env.BASE_CHAIN_ID || "84532", 10),
  baseUsdcAddress: process.env.BASE_USDC_ADDRESS || "",
  // Treasury address only — deliberately no private key counterpart here,
  // see .env.example. It receives transferWithAuthorization payments and
  // never signs in the hot path.
  platformBaseAddress: process.env.PLATFORM_BASE_ADDRESS || "",
  x402FacilitatorUrl: process.env.X402_FACILITATOR_URL || "",
  relayerEvmPrivateKey: process.env.RELAYER_EVM_PRIVATE_KEY || "",


  // Demo mode — forced false in production (see deriveDemoMode)
  demoMode: deriveDemoMode(process.env.DEMO_MODE, process.env.NODE_ENV),
} as const;
