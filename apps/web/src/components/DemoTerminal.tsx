import { useState } from "react";

interface Props { apiUrl: string; }
type Phase = "idle" | "running" | "done" | "error";
interface TxStep {
  name: string; description: string; price_usdc: string;
  tx_hash?: string; stellar_expert_url?: string;
  soroban_tx_hash?: string; soroban_explorer_url?: string;
  result: any;
}
interface DemoResult {
  agent_address: string; platform_address: string;
  total_paid_usdc: string; user_received: string;
  steps: TxStep[]; summary: string;
}
type LogLine = { type: "cmd"|"response"|"info"|"success"|"error"|"section"; text: string };

const COLOR: Record<string, string> = {
  section: "#a78bfa", cmd: "#60a5fa", response: "#9ca3af",
  info: "#6b7280", success: "#4ade80", error: "#f87171",
};
const STEPS_META: Record<string, { emoji: string; label: string }> = {
  bazaar_broadcast: { emoji: "🕸️", label: "Bazaar Broadcast" },
  bazaar_accept:    { emoji: "⛓️", label: "Lock Soroban HTLC" },
  cash_agents:      { emoji: "📍", label: "Buscar comercios" },
  reputation:       { emoji: "⭐", label: "Verificar reputación" },
  cash_request:     { emoji: "💵", label: "Intercambio USDC→MXN" },
  fund_micopay:     { emoji: "💚", label: "Fondear MicoPay" },
};

export default function DemoTerminal({ apiUrl }: Props) {
  const [phase,  setPhase]  = useState<Phase>("idle");
  const [logs,   setLogs]   = useState<LogLine[]>([]);
  const [result, setResult] = useState<DemoResult | null>(null);

  const add = (line: LogLine) => setLogs(p => [...p, line]);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const runDemo = async () => {
    setLogs([]); setResult(null); setPhase("running");
    add({ type: "section", text: "═══ MicoPay Protocol — Demo Completo ═══" });
    add({ type: "info",    text: 'Escenario: "Necesito $500 MXN en efectivo en la Roma, CDMX"' });
    add({ type: "info",    text: "El agente ejecuta 6 llamadas x402, cada una con USDC real en Stellar." });
    add({ type: "info",    text: "" });
    add({ type: "cmd",     text: `POST ${apiUrl}/api/v1/demo/run` });
    await sleep(400);
    add({ type: "info",    text: "  → Construyendo 6 txs USDC en Stellar testnet..." });
    await sleep(300);
    add({ type: "info",    text: "  → Firmando y enviando a Horizon..." });

    try {
      const res = await fetch(`${apiUrl}/api/v1/demo/run`, { method: "POST" });
      const data: DemoResult & { error?: string } = await res.json();
      if (!res.ok || data.error) {
        add({ type: "error", text: `✗ ${data.error ?? "Demo failed"}` });
        setPhase("error"); return;
      }

      for (const step of data.steps) {
        const meta = STEPS_META[step.name] ?? { emoji: "•", label: step.name };
        await sleep(300);
        add({ type: "section", text: `\n${meta.emoji}  PASO: ${meta.label}  ($${step.price_usdc} USDC)` });
        add({ type: "success", text: `  ✓ Pago confirmado en Stellar testnet` });
        if (step.tx_hash) add({ type: "response", text: `  tx: ${step.tx_hash}` });

        if (step.name === "bazaar_broadcast") {
          const s = step.result;
          if (s?.id) {
            add({ type: "response", text: `  intent: ${s.id} · ${s.offered?.symbol} → ${s.wanted?.symbol}` });
            add({ type: "info",    text: `  Agente publica intención cross-chain al Bazaar global` });
          }
        }
        if (step.name === "bazaar_accept") {
          const h = (step as any).soroban_tx_hash;
          const url = (step as any).soroban_explorer_url;
          if (h && !h.startsWith("demo_")) {
            add({ type: "success", text: `  ✓ USDC locked en Soroban HTLC (MicopayEscrow)` });
            add({ type: "response",text: `  soroban tx: ${h}` });
            if (url) add({ type: "success", text: `  stellar.expert: ${url}` });
          } else {
            add({ type: "info",    text: `  Stellar side anchored. AtomicSwapHTLC (37 tests) resuelve contraparte en producción.` });
          }
        }
        if (step.name === "cash_agents") {
          const agents = step.result?.agents ?? [];
          add({ type: "info",    text: `  tasa: ${step.result?.usdc_mxn_rate?.toFixed(2)} MXN/USDC · comercios: ${agents.length}` });
          if (agents[0]) {
            add({ type: "response", text: `  ★ ${agents[0].name} (${agents[0].distance_km}km, tier ${agents[0].tier})` });
            add({ type: "response", text: `    ${agents[0].address}` });
            add({ type: "response", text: `    $${agents[0].available_mxn} MXN disponibles · ${(agents[0].completion_rate*100).toFixed(0)}% completion` });
          }
        }
        if (step.name === "reputation") {
          const rep = step.result?.reputation;
          const sig = step.result?.agent_signal;
          if (rep) {
            add({ type: "response",text: `  ${rep.tier_emoji} ${rep.tier} · ${rep.completion_percent} · ${rep.trades_completed} trades · avg ${rep.avg_time_minutes}min` });
            if (rep.nft_soulbound) add({ type: "success", text: `  NFT: ${rep.nft_soulbound.token_id} (no transferible)` });
          }
          if (sig) add({ type: sig.trusted ? "success" : "error", text: `  → ${sig.recommendation}` });
        }
        if (step.name === "cash_request") {
          const r = step.result;
          if (r?.exchange) {
            add({ type: "response",text: `  $${r.exchange.amount_mxn} MXN = ${r.exchange.amount_usdc} USDC` });
            add({ type: "success", text: `  HTLC locked: ${r.exchange.htlc_tx_hash?.slice(0,24)}...` });
            add({ type: "success", text: `  "${r.instructions?.slice(0,90)}..."` });
          }
        }
        if (step.name === "fund_micopay") {
          add({ type: "success", text: `  El protocolo se financia a sí mismo. ✓` });
        }
      }

      await sleep(200);
      add({ type: "info",    text: "" });
      add({ type: "section", text: "═══ RESULTADO ═══" });
      add({ type: "success", text: `✓ ${data.summary}` });
      add({ type: "response",text: `  agente pagó: $${data.total_paid_usdc} USDC → usuario recibió: ${data.user_received}` });
      setResult(data); setPhase("done");
    } catch (err: any) {
      add({ type: "error", text: `✗ ${err.message ?? "Network error"}` });
      setPhase("error");
    }
  };

  const reset = () => { setPhase("idle"); setLogs([]); setResult(null); };

  return (
    <div style={{ fontFamily: "monospace" }}>
      {/* Header */}
      <div style={{ marginBottom: "1.25rem" }}>
        <h2 style={{ margin: "0 0 0.4rem", fontSize: "1.1rem", color: "white" }}>
          🍄 Demo — Agente IA consigue efectivo en México
        </h2>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "#6b7280", lineHeight: 1.5 }}>
          El agente recibe{" "}
          <span style={{ color: "#a78bfa" }}>"Necesito $500 MXN en efectivo en la Roma"</span>
          {" "}y ejecuta 6 llamadas x402 con USDC real. Sin cuenta. Sin API key. Sin banco.
        </p>
      </div>

      {/* Step cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem", marginBottom: "1.25rem" }}>
        {Object.entries(STEPS_META).map(([key, s], i) => {
          const done = result?.steps?.some(rs => rs.name === key);
          return (
            <div key={key} style={{
              background: done ? "#052e16" : "#111827",
              border: `1px solid ${done ? "#16a34a" : "#1f2937"}`,
              borderRadius: "8px", padding: "0.6rem", textAlign: "center",
            }}>
              <div style={{ fontSize: "1.1rem" }}>{s.emoji}</div>
              <div style={{ fontSize: "0.65rem", color: done ? "#4ade80" : "#9ca3af", fontWeight: "bold", marginTop: "0.2rem" }}>
                {i+1}. {s.label}
              </div>
              {done && <div style={{ fontSize: "0.6rem", color: "#4ade80", marginTop: "0.2rem" }}>✓</div>}
            </div>
          );
        })}
      </div>

      {/* Terminal */}
      <div style={{
        background: "#030712", border: "1px solid #1f2937", borderRadius: "8px",
        padding: "1rem", minHeight: "280px", maxHeight: "400px", overflowY: "auto", marginBottom: "1rem",
      }}>
        {logs.length === 0 && (
          <div style={{ color: "#374151", fontSize: "0.8rem" }}>
            <span style={{ color: "#4ade80" }}>$</span> Presiona{" "}
            <span style={{ color: "#60a5fa" }}>Ejecutar Demo</span> para iniciar...
          </div>
        )}
        {logs.map((line, i) => (
          <div key={i} style={{
            color: COLOR[line.type], fontSize: "0.78rem", lineHeight: 1.6, whiteSpace: "pre-wrap",
            fontWeight: line.type === "section" ? "bold" : "normal",
          }}>{line.text}</div>
        ))}
        {phase === "running" && <div style={{ color: "#4ade80", fontSize: "0.78rem" }}>▋</div>}
      </div>

      {/* Result summary */}
      {result && (
        <div style={{
          background: "#052e16", border: "1px solid #16a34a", borderRadius: "8px",
          padding: "1rem", marginBottom: "1rem",
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem",
        }}>
          <div>
            <div style={{ fontSize: "0.65rem", color: "#86efac", textTransform: "uppercase", letterSpacing: "0.05em" }}>Agente pagó</div>
            <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "white" }}>${result.total_paid_usdc} USDC</div>
          </div>
          <div>
            <div style={{ fontSize: "0.65rem", color: "#86efac", textTransform: "uppercase", letterSpacing: "0.05em" }}>Usuario recibió</div>
            <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#4ade80" }}>{result.user_received}</div>
          </div>
          <div style={{ gridColumn: "1/-1", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {result.steps.map(s => (
              <a key={s.name} href={s.soroban_explorer_url ?? s.stellar_expert_url} target="_blank" rel="noopener noreferrer"
                style={{
                  fontSize: "0.65rem", color: "#4ade80", background: "#14532d",
                  padding: "0.2rem 0.5rem", borderRadius: "4px", textDecoration: "none",
                  border: "1px solid #16a34a",
                }}>
                {STEPS_META[s.name]?.emoji} {s.name} ↗
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button onClick={runDemo} disabled={phase === "running"} style={{
          padding: "0.6rem 1.5rem", background: phase === "running" ? "#1f2937" : "#16a34a",
          color: phase === "running" ? "#6b7280" : "white", border: "none", borderRadius: "6px",
          cursor: phase === "running" ? "not-allowed" : "pointer",
          fontSize: "0.875rem", fontWeight: "bold", fontFamily: "monospace",
        }}>
          {phase === "running" ? "▶ Ejecutando..." : "▶ Ejecutar Demo"}
        </button>
        {phase !== "idle" && (
          <button onClick={reset} style={{
            padding: "0.6rem 1rem", background: "transparent", color: "#6b7280",
            border: "1px solid #374151", borderRadius: "6px", cursor: "pointer",
            fontSize: "0.875rem", fontFamily: "monospace",
          }}>↺ Reset</button>
        )}
      </div>
      <p style={{ marginTop: "0.6rem", fontSize: "0.68rem", color: "#4b5563" }}>
        Requiere DEMO_AGENT_SECRET_KEY con fondos USDC en Stellar testnet. Cada ejecución gasta ~$0.12 USDC reales.
      </p>
    </div>
  );
}
