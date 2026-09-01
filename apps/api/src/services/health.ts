import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { query } from "../db/schema.js";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  components: {
    database: ComponentHealth;
    stellarRpc: ComponentHealth;
    contracts: ContractsHealth;
  };
}

export interface ComponentHealth {
  status: "up" | "down";
  latencyMs?: number;
  error?: string;
}

export interface ContractsHealth {
  status: "up" | "down" | "partial";
  deployed: {
    escrow: ContractStatus;
    mxne: ContractStatus;
  };
}

export interface ContractStatus {
  deployed: boolean;
  error?: string;
}

async function measureLatency(fn: () => Promise<void>): Promise<{ latencyMs: number }> {
  const start = performance.now();
  await fn();
  const latencyMs = Math.round(performance.now() - start);
  return { latencyMs };
}

async function checkDatabase(): Promise<ComponentHealth> {
  try {
    const { latencyMs } = await measureLatency(async () => {
      const result = await query("SELECT 1 as health");
      if (result.rows[0]?.health !== 1) {
        throw new Error("Invalid health check response");
      }
    });
    return { status: "up", latencyMs };
  } catch (err) {
    return {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkStellarRpc(): Promise<ComponentHealth> {
  try {
    const { latencyMs } = await measureLatency(async () => {
      const response = await fetch(config.stellarRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getHealth",
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as { jsonrpc?: string };
      if (data.jsonrpc !== "2.0") {
        throw new Error("Invalid RPC response");
      }
    });
    return { status: "up", latencyMs };
  } catch (err) {
    return {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkContractDeployed(contractId: string): Promise<ContractStatus> {
  if (!contractId) {
    return { deployed: false, error: "Contract ID not configured" };
  }

  try {
    // getLedgerEntry (singular) ya no existe: el RPC de mainnet (27.1.1)
    // responde -32601. El vigente es getLedgerEntries, con la LedgerKey en
    // XDR base64 — aquí, la instancia del contrato.
    const key = StellarSdk.xdr.LedgerKey.contractData(
      new StellarSdk.xdr.LedgerKeyContractData({
        contract: new StellarSdk.Address(contractId).toScAddress(),
        key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: StellarSdk.xdr.ContractDataDurability.persistent(),
      }),
    ).toXDR("base64");

    const response = await fetch(config.stellarRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLedgerEntries",
        params: { keys: [key] },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      result?: { entries?: unknown[] };
      error?: { message?: string };
    };
    if (data.error) {
      throw new Error(data.error.message ?? "RPC error");
    }
    if (!data.result?.entries?.length) {
      return { deployed: false, error: "Contract not found" };
    }

    return { deployed: true };
  } catch (err) {
    return {
      deployed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkContracts(): Promise<ContractsHealth> {
  const [escrowStatus, mxneStatus] = await Promise.all([
    checkContractDeployed(config.escrowContractId),
    checkContractDeployed(config.mxneContractId),
  ]);

  const allDeployed = escrowStatus.deployed && mxneStatus.deployed;
  const anyDeployed = escrowStatus.deployed || mxneStatus.deployed;

  return {
    status: allDeployed ? "up" : anyDeployed ? "partial" : "down",
    deployed: {
      escrow: escrowStatus,
      mxne: mxneStatus,
    },
  };
}

export async function checkHealth(): Promise<HealthStatus> {
  const [database, stellarRpc, contracts] = await Promise.all([
    checkDatabase(),
    checkStellarRpc(),
    checkContracts(),
  ]);

  const allUp =
    database.status === "up" &&
    stellarRpc.status === "up" &&
    contracts.status === "up";

  const anyDown =
    database.status === "down" ||
    stellarRpc.status === "down" ||
    contracts.status === "down";

  const status: HealthStatus["status"] = allUp
    ? "healthy"
    : anyDown
    ? "unhealthy"
    : "degraded";

  return {
    status,
    timestamp: new Date().toISOString(),
    components: {
      database,
      stellarRpc,
      contracts,
    },
  };
}

export default { checkHealth };
