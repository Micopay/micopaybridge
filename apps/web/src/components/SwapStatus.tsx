import { useState, useEffect, useRef } from "react";

const EXPLORER = "https://stellar.expert/explorer/testnet";
const XRPL_EXPLORER = "https://testnet.xrpl.org";

// Cada tx a su explorador. La pierna B vive en XRPL desde M4.5; enlazarla a
// stellar.expert la haría parecer inexistente.
const TX_CHAIN = {
  lock_a: "stellar",
  release_a: "stellar",
  refund_a: "stellar",
  lock_b: "xrpl",
  release_b: "xrpl",
  refund_b: "xrpl",
} as const;

/**
 * Swap real y completo entre las dos testnets. No es un mockup: son las
 * cuatro transacciones de una corrida de `npm run test:live -w @micopay/api`
 * el 2026-08-07, y se pueden abrir en sus exploradores.
 *
 * Antes esta constante enseñaba dos contratos de Soroban (contract_a y
 * contract_b). Eso era la cadena B simulada: las dos piernas en la misma
 * cadena. Ya no.
 */
const REAL_SWAP = {
  status: "completed",
  sell: "0.10 XLM",
  buy: "2.00 XRP",
  duration: "24 s de punta a punta",
  contract_a: "CANNVHGZHVSVQO76SIVV5YNHH6ODDBV5IEROUITFTFIH6NRLF7XHRCIT",
  xrpl_escrow_owner: "rGrZ3hMyAP38Sbn6XE4vMW6a73dVQXF9pW",
  xrpl_destination: "rGUSJDCuL6UE3RBiVVfCQEGiwaEtmw8ni1",
  txs: {
    lock_a:    "6b5f0865c9daedf8a5c370dabecc2e32bf1f46568f6304b7f09aaf1dfb21f3ab",
    lock_b:    "41BBE9B40A23B5D699482B5DF12995E791636DD3A4D5B16357548D33D836B229",
    release_b: "591610E4143F041B3A2C9CCD343FF7291FC4BCB8B3446C740F5AFE187ECBFB3E",
    release_a: "d668659c9a0099c40b37380c48eb7aa7a73d4ce0d012cc92b3c471af9eccf1bb",
  },
  secret_hash: "8593e67ecbcd7db9f3f17a21b159f89e5ca0c6c4e2e803a2ff1ff3383c4a6868",
  condition:   "A02580208593E67ECBCD7DB9F3F17A21B159F89E5CA0C6C4E2E803A2FF1FF3383C4A6868810120",
  started: "testnets XRPL + Soroban · 2026-08-07",
};

interface Props { apiUrl: string }

const STATUS_COLORS: Record<string, string> = {
  completed:   "#4ade80",
  locked:      "#facc15",
  executing:   "#60a5fa",
  failed:      "#f87171",
};

// Swap execution states with labels and progress %
const SWAP_STEPS: { status: string; label: string; pct: number }[] = [
  { status: "queued",      label: "Queued",              pct: 5  },
  { status: "locking_a",   label: "Locking USDC (A)...", pct: 20 },
  { status: "locked_a",    label: "USDC Locked ✓",       pct: 35 },
  { status: "locking_b",   label: "Locking XRP (XRPL)...", pct: 50 },
  { status: "locked_b",    label: "XRP escrow created ✓", pct: 65 },
  { status: "releasing_b", label: "Revealing preimage on XRPL...", pct: 75 },
  { status: "released_b",  label: "Preimage public on XRPL ✓", pct: 85 },
  { status: "releasing_a", label: "Claiming on Soroban...", pct: 95 },
  { status: "completed",   label: "Swap Complete ✓",      pct: 100},
  { status: "failed",      label: "Failed ✗",             pct: 0  },
];

function stepPct(status: string): number {
  return SWAP_STEPS.find(s => s.status === status)?.pct ?? 0;
}
function stepLabel(status: string): string {
  return SWAP_STEPS.find(s => s.status === status)?.label ?? status;
}

export default function SwapStatus({ apiUrl }: Props) {
  // ── Poll by ID ───────────────────────────────────────────────────────────
  const [swapId,   setSwapId]  = useState("");
  const [result,   setResult]  = useState<string | null>(null);
  const [loading,  setLoading] = useState(false);

  const pollStatus = async () => {
    if (!swapId.trim()) return;
    setLoading(true); setResult(null);
    try {
      const res  = await fetch(`${apiUrl}/api/v1/swaps/${swapId}/status`, {
        headers: { "x-payment": "mock:GAGENT_DEMO:0.0001" },
      });
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setResult(`Error: ${err}`);
    } finally { setLoading(false); }
  };

  // ── Live Execute ─────────────────────────────────────────────────────────
  const [execRunning, setExecRunning] = useState(false);
  const [execStatus,  setExecStatus]  = useState<string | null>(null);
  const [execSwapId,  setExecSwapId]  = useState<string | null>(null);
  const [execData,    setExecData]    = useState<any | null>(null);
  const [execLog,     setExecLog]     = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = (msg: string) => setExecLog(p => [...p, msg]);

  const runLiveSwap = async () => {
    setExecRunning(true);
    setExecStatus(null);
    setExecSwapId(null);
    setExecData(null);
    setExecLog([]);

    try {
      // Step 1: Plan
      addLog("→ POST /api/v1/swaps/plan  ($0.01)");
      const planRes = await fetch(`${apiUrl}/api/v1/swaps/plan`, {
        method: "POST",
        headers: { "x-payment": "mock:GAGENT_DEMO:0.01", "Content-Type": "application/json" },
        // La pierna B es XRPL: el ejecutor rechaza cualquier buy_asset que no sea XRP.
        body: JSON.stringify({ intent: "swap 0.1 XLM for XRP, best rate", user_address: "GDEMO" }),
      });
      const planData = await planRes.json();
      const planId = planData.plan?.id;
      if (!planId) throw new Error(planData.error ?? "No plan returned");
      addLog(`✓ Plan: ${planId}  →  ${planData.plan?.amounts?.sell_amount} ${planData.plan?.amounts?.sell_asset} → ${planData.plan?.amounts?.buy_amount} ${planData.plan?.amounts?.buy_asset}`);

      // Step 2: Execute
      addLog("→ POST /api/v1/swaps/execute  ($0.05)");
      const execRes = await fetch(`${apiUrl}/api/v1/swaps/execute`, {
        method: "POST",
        headers: { "x-payment": "mock:GAGENT_DEMO:0.05", "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: planId }),
      });
      const execResp = await execRes.json();
      const newSwapId = execResp.swap_id;
      if (!newSwapId) throw new Error(execResp.error ?? "No swap_id returned");
      setExecSwapId(newSwapId);
      setExecStatus("queued");
      addLog(`✓ Swap queued: ${newSwapId}`);
      addLog("⏳ Polling cada 5 s — 2 txs en Soroban + 2 en XRPL...");

      // Step 3: Poll until done
      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`${apiUrl}/api/v1/swaps/${newSwapId}/status`, {
            headers: { "x-payment": "mock:GAGENT_DEMO:0.0001" },
          });
          const statusData = await statusRes.json();
          const prev = execStatus;
          setExecStatus(statusData.status);
          setExecData(statusData);

          if (statusData.status !== prev) {
            addLog(`  ${stepLabel(statusData.status)}`);
            if (statusData.txs?.lock_a    && !prev?.includes("locked_a"))    addLog(`    tx lock_a:    ${statusData.txs.lock_a.slice(0,14)}...`);
            if (statusData.txs?.lock_b    && !prev?.includes("locked_b"))    addLog(`    tx lock_b:    ${statusData.txs.lock_b.slice(0,14)}...`);
            if (statusData.txs?.release_b && !prev?.includes("released_b"))  addLog(`    tx release_b: ${statusData.txs.release_b.slice(0,14)}...`);
            if (statusData.txs?.release_a && !prev?.includes("completed"))   addLog(`    tx release_a: ${statusData.txs.release_a.slice(0,14)}...`);
          }

          if (statusData.status === "completed" || statusData.status === "failed") {
            clearInterval(pollRef.current!);
            setExecRunning(false);
            if (statusData.status === "completed") addLog("✓ Atomic swap complete — trustless, on-chain, atomic.");
            else addLog(`✗ Failed: ${statusData.error}`);
          }
        } catch { /* ignore poll errors */ }
      }, 5000);

    } catch (err) {
      addLog(`✗ Error: ${err}`);
      setExecRunning(false);
    }
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Styles ───────────────────────────────────────────────────────────────
  const box: React.CSSProperties = {
    background: "#111827", border: "1px solid #1f2937",
    borderRadius: "0.5rem", padding: "1.5rem", marginBottom: "1rem",
  };

  const txUrl = (key: keyof typeof TX_CHAIN, hash: string) =>
    TX_CHAIN[key] === "xrpl"
      ? `${XRPL_EXPLORER}/transactions/${hash}`
      : `${EXPLORER}/tx/${hash}`;

  const txRow = (label: string, key: keyof typeof TX_CHAIN, hash: string, color = "#a78bfa") => (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: "#4b5563", width: "150px", flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: "0.6rem", padding: "0.05rem 0.3rem", borderRadius: "0.2rem", flexShrink: 0,
        background: TX_CHAIN[key] === "xrpl" ? "#1e1b4b" : "#0c2d3d",
        color: TX_CHAIN[key] === "xrpl" ? "#a5b4fc" : "#67e8f9",
      }}>
        {TX_CHAIN[key] === "xrpl" ? "XRPL" : "Soroban"}
      </span>
      <a href={txUrl(key, hash)} target="_blank" rel="noopener noreferrer"
        style={{ fontSize: "0.7rem", color, fontFamily: "monospace", textDecoration: "none" }}>
        {hash.slice(0, 12)}...{hash.slice(-6)} ↗
      </a>
    </div>
  );

  return (
    <div>
      {/* ── Lifecycle diagram ───────────────────────────────────────────── */}
      <div style={box}>
        <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.25rem", color: "white" }}>Atomic Swap XRPL ↔ Soroban</h2>
        <p style={{ margin: "0 0 1rem", fontSize: "0.75rem", color: "#6b7280" }}>
          Dos cadenas de verdad. La pierna de XRPL es un escrow nativo del ledger
          (<code style={{ color: "#a5b4fc" }}>EscrowCreate</code> con <code style={{ color: "#a5b4fc" }}>Condition</code> PREIMAGE-SHA-256
          y <code style={{ color: "#a5b4fc" }}>CancelAfter</code>) — no hay contrato que desplegar.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
          {[
            { label: "Intent",       color: "#4ade80", bg: "#14532d", border: "#166534" },
            { label: "Plan (Claude)", color: "#4ade80", bg: "#14532d", border: "#166534" },
            { label: "Lock A · Soroban",  color: "#67e8f9", bg: "#0c2d3d", border: "#0e7490" },
            { label: "Lock B · XRPL",     color: "#a5b4fc", bg: "#1e1b4b", border: "#4338ca" },
            { label: "Reveal · XRPL",     color: "#a5b4fc", bg: "#1e1b4b", border: "#4338ca" },
            { label: "Claim · Soroban",   color: "#67e8f9", bg: "#0c2d3d", border: "#0e7490" },
            { label: "Complete",      color: "#4ade80", bg: "#052e16", border: "#15803d" },
          ].map(({ label, color, bg, border }, i, arr) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <div style={{ padding: "0.25rem 0.5rem", borderRadius: "0.25rem", fontSize: "0.7rem", background: bg, color, border: `1px solid ${border}` }}>
                {label}
              </div>
              {i < arr.length - 1 && <span style={{ color: "#4b5563" }}>→</span>}
            </div>
          ))}
        </div>

        {/* Completed reference swap */}
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Swap de referencia — corrido en testnet, {REAL_SWAP.duration}
        </h3>
        <div style={{ padding: "1rem", background: "#0f172a", borderRadius: "0.375rem", borderLeft: `3px solid ${STATUS_COLORS.completed}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
            <div>
              <span style={{ fontSize: "1rem", color: "white", fontWeight: "bold" }}>{REAL_SWAP.sell} → {REAL_SWAP.buy}</span>
              <span style={{ marginLeft: "0.5rem", padding: "0.1rem 0.4rem", borderRadius: "0.25rem", fontSize: "0.7rem", background: "#1f2937", color: STATUS_COLORS.completed }}>{REAL_SWAP.status}</span>
            </div>
            <span style={{ fontSize: "0.7rem", color: "#4b5563" }}>{REAL_SWAP.started}</span>
          </div>
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.7rem", marginBottom: "0.2rem" }}>
              <span style={{ color: "#4b5563" }}>Pierna A — AtomicSwapHTLC (Soroban): </span>
              <a href={`${EXPLORER}/contract/${REAL_SWAP.contract_a}`} target="_blank" rel="noopener noreferrer" style={{ color: "#a78bfa", fontFamily: "monospace", fontSize: "0.68rem", textDecoration: "none" }}>
                {REAL_SWAP.contract_a.slice(0, 10)}...{REAL_SWAP.contract_a.slice(-6)} ↗
              </a>
            </div>
            <div style={{ fontSize: "0.7rem" }}>
              <span style={{ color: "#4b5563" }}>Pierna B — escrow nativo XRPL, sin contrato: </span>
              <a href={`${XRPL_EXPLORER}/accounts/${REAL_SWAP.xrpl_escrow_owner}`} target="_blank" rel="noopener noreferrer" style={{ color: "#a5b4fc", fontFamily: "monospace", fontSize: "0.68rem", textDecoration: "none" }}>
                {REAL_SWAP.xrpl_escrow_owner.slice(0, 10)}...{REAL_SWAP.xrpl_escrow_owner.slice(-6)} ↗
              </a>
            </div>
          </div>
          <div style={{ borderTop: "1px solid #1f2937", paddingTop: "0.75rem" }}>
            <div style={{ fontSize: "0.7rem", color: "#4b5563", marginBottom: "0.4rem" }}>On-chain transactions:</div>
            {txRow("1. Lock XLM",         "lock_a",    REAL_SWAP.txs.lock_a,    "#60a5fa")}
            {txRow("2. EscrowCreate XRP", "lock_b",    REAL_SWAP.txs.lock_b,    "#60a5fa")}
            {txRow("3. EscrowFinish",     "release_b", REAL_SWAP.txs.release_b, "#4ade80")}
            {txRow("4. Release Soroban",  "release_a", REAL_SWAP.txs.release_a, "#4ade80")}
          </div>
          <div style={{ marginTop: "0.75rem", padding: "0.6rem", background: "#052e16", borderRadius: "0.25rem", fontSize: "0.7rem", color: "#4ade80", lineHeight: 1.6 }}>
            ✓ La preimagen se revela en la tx #3 y queda pública en el ledger de XRPL; la
            contraparte la usa en la #4. Atómico por criptografía, no por confianza.
            <div style={{ marginTop: "0.5rem", color: "#86efac", fontFamily: "monospace", fontSize: "0.62rem", wordBreak: "break-all" }}>
              secret_hash <span style={{ color: "#4ade80" }}>{REAL_SWAP.secret_hash}</span>
              <br />
              condition &nbsp;&nbsp;<span style={{ color: "#6b7280" }}>A0258020</span>
              <span style={{ color: "#4ade80" }}>{REAL_SWAP.secret_hash.toUpperCase()}</span>
              <span style={{ color: "#6b7280" }}>810120</span>
            </div>
            <div style={{ marginTop: "0.35rem", color: "#86efac" }}>
              El fingerprint de la condition de XRPL <strong>es</strong> el hash que valida
              Soroban. Una sola preimagen gobierna las dos piernas.
            </div>
          </div>
        </div>
      </div>

      {/* ── Live Execute ────────────────────────────────────────────────── */}
      <div style={box}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div>
            <h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem", color: "white" }}>Execute Live Swap</h3>
            <p style={{ margin: 0, fontSize: "0.75rem", color: "#6b7280" }}>
              Plan → Execute → 2 txs en Soroban + 2 en XRPL, contra testnets reales
            </p>
          </div>
          <button
            onClick={runLiveSwap}
            disabled={execRunning}
            style={{
              padding: "0.5rem 1.25rem",
              background: execRunning ? "#1f2937" : "#1e3a5f",
              border: `1px solid ${execRunning ? "#374151" : "#1d4ed8"}`,
              borderRadius: "0.375rem",
              color: execRunning ? "#4b5563" : "#60a5fa",
              fontSize: "0.875rem",
              cursor: execRunning ? "not-allowed" : "pointer",
              fontFamily: "monospace",
            }}
          >
            {execRunning ? "Running..." : "▶ Execute Swap"}
          </button>
        </div>

        {execLog.length > 0 && (
          <>
            {/* Progress bar */}
            {execStatus && execStatus !== "failed" && (
              <div style={{ marginBottom: "0.75rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.7rem", color: "#4b5563", marginBottom: "0.25rem" }}>
                  <span>{stepLabel(execStatus)}</span>
                  <span>{stepPct(execStatus)}%</span>
                </div>
                <div style={{ height: "4px", background: "#1f2937", borderRadius: "2px" }}>
                  <div style={{
                    height: "100%", borderRadius: "2px",
                    background: execStatus === "completed" ? "#4ade80" : execStatus === "failed" ? "#f87171" : "#60a5fa",
                    width: `${stepPct(execStatus)}%`,
                    transition: "width 0.5s ease",
                  }} />
                </div>
              </div>
            )}

            {/* Log terminal */}
            <div style={{
              background: "#0a0f1e", borderRadius: "0.375rem", padding: "0.75rem",
              fontFamily: "monospace", fontSize: "0.75rem", lineHeight: "1.8",
              maxHeight: "240px", overflowY: "auto",
            }}>
              {execLog.map((line, i) => (
                <div key={i} style={{ color: line.startsWith("✓") ? "#4ade80" : line.startsWith("✗") ? "#f87171" : line.startsWith("⏳") ? "#facc15" : "#9ca3af" }}>
                  {line}
                </div>
              ))}
              {execRunning && <span style={{ color: "#4ade80" }}>▋</span>}
            </div>

            {/* Completed tx links */}
            {execData?.status === "completed" && execData.txs && (
              <div style={{ marginTop: "0.75rem", padding: "0.75rem", background: "#052e16", borderRadius: "0.375rem", border: "1px solid #15803d" }}>
                <div style={{ fontSize: "0.7rem", color: "#4b5563", marginBottom: "0.5rem" }}>On-chain transactions — verified on testnet:</div>
                {execData.txs.lock_a    && txRow("1. Lock USDC",  execData.txs.lock_a,    "#60a5fa")}
                {execData.txs.lock_b    && txRow("2. Lock XLM",   execData.txs.lock_b,    "#60a5fa")}
                {execData.txs.release_b && txRow("3. Release B",  execData.txs.release_b, "#4ade80")}
                {execData.txs.release_a && txRow("4. Release A",  execData.txs.release_a, "#4ade80")}
                <div style={{ marginTop: "0.5rem", fontSize: "0.7rem", color: "#4ade80" }}>
                  ✓ {execData.sell} → {execData.buy} · trustless, atomic.
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Poll by ID ──────────────────────────────────────────────────── */}
      <div style={box}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Poll Swap Status by ID
        </h3>
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <input
            value={swapId}
            onChange={(e) => setSwapId(e.target.value)}
            placeholder="swap_id..."
            style={{ flex: 1, padding: "0.5rem 0.75rem", background: "#0f172a", border: "1px solid #374151", borderRadius: "0.375rem", color: "white", fontSize: "0.875rem", fontFamily: "monospace" }}
          />
          <button
            onClick={pollStatus}
            disabled={loading}
            style={{ padding: "0.5rem 1rem", background: "#166534", border: "1px solid #15803d", borderRadius: "0.375rem", color: "#4ade80", fontSize: "0.875rem", cursor: "pointer", fontFamily: "monospace" }}
          >
            {loading ? "..." : "Poll"}
          </button>
        </div>
        {result && (
          <pre style={{ margin: 0, fontSize: "0.75rem", color: "#d1d5db", background: "#0f172a", padding: "0.75rem", borderRadius: "0.375rem", overflowX: "auto" }}>
            {result}
          </pre>
        )}
      </div>
    </div>
  );
}
