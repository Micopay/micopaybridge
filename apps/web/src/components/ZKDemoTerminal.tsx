import { useState } from "react";

interface Props { apiUrl: string; }
type Phase = "idle" | "running" | "done" | "error";
interface ZKStep {
  name: string; description: string; price_usdc: string;
  tx_hash?: string; stellar_expert_url?: string;
  soroban_tx_hash?: string; soroban_explorer_url?: string;
  rejected_as_expected?: boolean;
  result: any;
}
interface ZKDemoResult {
  agent_address: string; platform_address: string;
  total_paid_usdc: string; steps: ZKStep[]; summary: string;
}
type LogLine = { type: "cmd"|"response"|"info"|"success"|"error"|"section"; text: string };

const COLOR: Record<string, string> = {
  section: "#a78bfa", cmd: "#60a5fa", response: "#9ca3af",
  info: "#6b7280", success: "#4ade80", error: "#f87171",
};
const STEPS_META: Record<string, { emoji: string; label: string }> = {
  credential_buy:            { emoji: "🎟️", label: "Comprar (público)" },
  inference_spend:           { emoji: "🔐", label: "Gastar (anónimo)" },
  inference_reuse_rejected:  { emoji: "🚫", label: "Reintentar (rechazado)" },
};

export default function ZKDemoTerminal({ apiUrl }: Props) {
  const [phase,  setPhase]  = useState<Phase>("idle");
  const [logs,   setLogs]   = useState<LogLine[]>([]);
  const [result, setResult] = useState<ZKDemoResult | null>(null);

  const add = (line: LogLine) => setLogs(p => [...p, line]);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const runDemo = async () => {
    setLogs([]); setResult(null); setPhase("running");
    add({ type: "section", text: "═══ MicoPay — Acceso ZK Anónimo ═══" });
    add({ type: "info",    text: "El agente paga en público, y gasta su acceso en anónimo." });
    add({ type: "info",    text: "Nadie — ni MicoPay — puede unir la compra con el uso." });
    add({ type: "info",    text: "" });
    add({ type: "cmd",     text: `POST ${apiUrl}/api/v1/demo/run-zk` });
    await sleep(400);
    add({ type: "info",    text: "  → Comprando credencial anónima (pago x402 real en Stellar)..." });

    try {
      const res = await fetch(`${apiUrl}/api/v1/demo/run-zk`, { method: "POST" });
      const data: ZKDemoResult & { error?: string } = await res.json();
      if (!res.ok || data.error) {
        add({ type: "error", text: `✗ ${(data as any).error ?? "Demo failed"}` });
        setPhase("error"); return;
      }

      for (const step of data.steps) {
        const meta = STEPS_META[step.name] ?? { emoji: "•", label: step.name };
        await sleep(step.name === "inference_spend" ? 600 : 300);
        add({ type: "section", text: `\n${meta.emoji}  PASO: ${meta.label}` });

        if (step.name === "credential_buy") {
          add({ type: "success", text: "  ✓ Pago confirmado en Stellar testnet — PÚBLICO, y está bien: un pago no tiene nada que esconder." });
          if (step.tx_hash) add({ type: "response", text: `  tx: ${step.tx_hash}` });
          const anon = step.result?.note?.match(/Anonymity set = (\d+)/)?.[1];
          if (anon) add({ type: "info", text: `  anonymity set en este demo: ${anon} credenciales bajo la misma raíz` });
        }

        if (step.name === "inference_spend") {
          add({ type: "success", text: "  ✓ El agente demostró que tiene una ficha válida y la gastó — SIN decir cuál ni quién es." });
          if (step.soroban_tx_hash) add({ type: "response", text: `  verify_unique (Soroban) tx: ${step.soroban_tx_hash}` });
          const completion = step.result?.completion;
          if (completion) {
            add({ type: "info", text: "" });
            add({ type: "success", text: `  💬 Claude responde: "${completion}"` });
          }
        }

        if (step.name === "inference_reuse_rejected") {
          if (step.rejected_as_expected) {
            add({ type: "success", text: "  ✓ Rechazado on-chain: la ficha ya se había quemado." });
            add({ type: "response", text: `  → ${step.result?.error}` });
            add({ type: "info", text: "  Un solo uso. Anónimo, pero no infinito." });
          } else {
            add({ type: "error", text: "  ✗ Inesperado: el reintento NO fue rechazado." });
          }
        }
      }

      await sleep(200);
      add({ type: "info",    text: "" });
      add({ type: "section", text: "═══ RESULTADO ═══" });
      add({ type: "success", text: `✓ ${data.summary}` });
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
          🔐 Demo — Acceso anónimo verificado con ZK en Soroban
        </h2>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "#6b7280", lineHeight: 1.5 }}>
          El agente compra una credencial (pago público), y la gasta con una prueba{" "}
          <span style={{ color: "#a78bfa" }}>zero-knowledge</span> — sin revelar cuál ni quién
          es. Reusarla se rechaza on-chain. Verificado en Stellar/Soroban, no confiando en
          nuestra palabra.
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
        padding: "1rem", minHeight: "280px", maxHeight: "420px", overflowY: "auto", marginBottom: "1rem",
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
        }}>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {result.steps.map(s => {
              const url = s.soroban_explorer_url ?? s.stellar_expert_url;
              if (!url) return null;
              return (
                <a key={s.name} href={url} target="_blank" rel="noopener noreferrer"
                  style={{
                    fontSize: "0.65rem", color: "#4ade80", background: "#14532d",
                    padding: "0.2rem 0.5rem", borderRadius: "4px", textDecoration: "none",
                    border: "1px solid #16a34a",
                  }}>
                  {STEPS_META[s.name]?.emoji} {s.name} ↗
                </a>
              );
            })}
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
      <p style={{ marginTop: "0.6rem", fontSize: "0.68rem", color: "#f87171" }}>
        ⚠️ Recurso limitado: el pool de demo tiene muy pocas credenciales sin gastar (cada
        corrida quema una para siempre, en cadena — no se recupera reiniciando el servidor).
        No lo ejecutes de más antes de grabar.
      </p>
    </div>
  );
}
