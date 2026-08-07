import { useState, useEffect, useRef } from "react";

const EXPLORER = "https://stellar.expert/explorer/testnet";

// Real completed atomic swap from testnet
const REAL_SWAP = {
  id: "3960c267aa93024af477ca8d57ee92c0adea2ed43d46e1602709dc4824da1516",
  status: "completed",
  sell: "0.50 USDC",
  buy: "3.00 XLM",
  initiator: "GDKKW2WS...BJJK",
  counterparty: "GCRFPFSN...F3AA",
  contract_a: "CCDOUXIXSFXT2HTJAJGFNUJN6CKCYX2M6AL2BHHPEF6ISNHP2BGLS4KX",
  contract_b: "CBLCGG44QQILWEIVBXDSZSLH7NI7SGJQKXQ7WTKP3W3YSXOBTGMZKSNN",
  txs: {
    lock_a:    "5d2b1bd61adebe8946e1986d58560ca3d4379219afe3375b142e8c02b0b00bf6",
    lock_b:    "4123aadfe4b53f6fe9bbc60150cee7b0e06f2500ee276f114f2f833a0325b502",
    release_b: "4db1ba5520485b13aad5fe86537411a6a905424c3dd2066f6be9c78a7f34f0eb",
    release_a: "34057acde13d0117737ddbb141e9a6c6641418fc7cbfb6a35db6f00201f8ee64",
  },
  secret_hash: "35a57759fcf2fd9b9c27c5e9c0287453da4b677a34d98b730ab71340a2bb5823",
  started: "live on testnet",
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
  { status: "locking_b",   label: "Locking XLM (B)...",  pct: 50 },
  { status: "locked_b",    label: "XLM Locked ✓",        pct: 65 },
  { status: "releasing_b", label: "Revealing secret...",  pct: 75 },
  { status: "released_b",  label: "Secret Revealed ✓",   pct: 85 },
  { status: "releasing_a", label: "Claiming USDC...",     pct: 95 },
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
        body: JSON.stringify({ intent: "swap 0.5 USDC for XLM, best rate", user_address: "GDEMO" }),
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
      addLog("⏳ Polling status every 5s — 4 Soroban txs in progress...");

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

  const txRow = (label: string, hash: string, color = "#a78bfa") => (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: "#4b5563", width: "80px", flexShrink: 0 }}>{label}</span>
      <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noopener noreferrer"
        style={{ fontSize: "0.7rem", color, fontFamily: "monospace", textDecoration: "none" }}>
        {hash.slice(0, 12)}...{hash.slice(-6)} ↗
      </a>
    </div>
  );

  return (
    <div>
      {/* ── Lifecycle diagram ───────────────────────────────────────────── */}
      <div style={box}>
        <h2 style={{ margin: "0 0 1rem", fontSize: "1.25rem", color: "white" }}>Atomic Swap Lifecycle</h2>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
          {[
            { label: "Intent",       color: "#4ade80", bg: "#14532d", border: "#166534" },
            { label: "Plan (Claude)", color: "#4ade80", bg: "#14532d", border: "#166534" },
            { label: "Lock A",        color: "#60a5fa", bg: "#1e3a5f", border: "#1d4ed8" },
            { label: "Lock B",        color: "#60a5fa", bg: "#1e3a5f", border: "#1d4ed8" },
            { label: "Release B",     color: "#c4b5fd", bg: "#3b0764", border: "#6d28d9" },
            { label: "Release A",     color: "#c4b5fd", bg: "#3b0764", border: "#6d28d9" },
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
          Reference Swap — Completed on Testnet
        </h3>
        <div style={{ padding: "1rem", background: "#0f172a", borderRadius: "0.375rem", borderLeft: `3px solid ${STATUS_COLORS.completed}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
            <div>
              <span style={{ fontSize: "1rem", color: "white", fontWeight: "bold" }}>{REAL_SWAP.sell} → {REAL_SWAP.buy}</span>
              <span style={{ marginLeft: "0.5rem", padding: "0.1rem 0.4rem", borderRadius: "0.25rem", fontSize: "0.7rem", background: "#1f2937", color: STATUS_COLORS.completed }}>{REAL_SWAP.status}</span>
            </div>
            <span style={{ fontSize: "0.7rem", color: "#4b5563" }}>{REAL_SWAP.started}</span>
          </div>
          <div style={{ marginBottom: "0.75rem", fontSize: "0.7rem", color: "#4b5563" }}>
            swap_id: <code style={{ color: "#60a5fa", fontSize: "0.68rem" }}>{REAL_SWAP.id.slice(0, 16)}...{REAL_SWAP.id.slice(-8)}</code>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.7rem" }}><span style={{ color: "#4b5563" }}>initiator: </span><code style={{ color: "#60a5fa" }}>{REAL_SWAP.initiator}</code></div>
            <div style={{ fontSize: "0.7rem" }}><span style={{ color: "#4b5563" }}>counterparty: </span><code style={{ color: "#60a5fa" }}>{REAL_SWAP.counterparty}</code></div>
          </div>
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.7rem", marginBottom: "0.2rem" }}>
              <span style={{ color: "#4b5563" }}>Contract A (USDC): </span>
              <a href={`${EXPLORER}/contract/${REAL_SWAP.contract_a}`} target="_blank" rel="noopener noreferrer" style={{ color: "#a78bfa", fontFamily: "monospace", fontSize: "0.68rem", textDecoration: "none" }}>
                {REAL_SWAP.contract_a.slice(0, 10)}...{REAL_SWAP.contract_a.slice(-6)} ↗
              </a>
            </div>
            <div style={{ fontSize: "0.7rem" }}>
              <span style={{ color: "#4b5563" }}>Contract B (XLM):  </span>
              <a href={`${EXPLORER}/contract/${REAL_SWAP.contract_b}`} target="_blank" rel="noopener noreferrer" style={{ color: "#a78bfa", fontFamily: "monospace", fontSize: "0.68rem", textDecoration: "none" }}>
                {REAL_SWAP.contract_b.slice(0, 10)}...{REAL_SWAP.contract_b.slice(-6)} ↗
              </a>
            </div>
          </div>
          <div style={{ borderTop: "1px solid #1f2937", paddingTop: "0.75rem" }}>
            <div style={{ fontSize: "0.7rem", color: "#4b5563", marginBottom: "0.4rem" }}>On-chain transactions:</div>
            {txRow("1. Lock USDC",  REAL_SWAP.txs.lock_a,    "#60a5fa")}
            {txRow("2. Lock XLM",   REAL_SWAP.txs.lock_b,    "#60a5fa")}
            {txRow("3. Release B",  REAL_SWAP.txs.release_b, "#4ade80")}
            {txRow("4. Release A",  REAL_SWAP.txs.release_a, "#4ade80")}
          </div>
          <div style={{ marginTop: "0.75rem", padding: "0.5rem", background: "#052e16", borderRadius: "0.25rem", fontSize: "0.7rem", color: "#4ade80" }}>
            ✓ Secret revealed in tx #3 → used by counterparty in tx #4. Atomic by cryptography.
          </div>
        </div>
      </div>

      {/* ── Live Execute ────────────────────────────────────────────────── */}
      <div style={box}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div>
            <h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem", color: "white" }}>Execute Live Swap</h3>
            <p style={{ margin: 0, fontSize: "0.75rem", color: "#6b7280" }}>
              Plan → Execute → 4 Soroban txs on testnet (~2 min)
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
