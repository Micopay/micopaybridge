import { useState } from "react";

interface Props { apiUrl: string; }

const KNOWN_MERCHANTS = [
  { address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKUJI5KOOJ9TXWNTBBS2JN", label: "Farmacia Guadalupe (Maestro 🍄)" },
  { address: "GDAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A", label: "Tienda Don Pepe (Experto ⭐)" },
  { address: "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4B", label: "Mini Super Estrella (Espora 🌱)" },
];

export default function ReputationPanel({ apiUrl }: Props) {
  const [address, setAddress]   = useState(KNOWN_MERCHANTS[0].address);
  const [loading, setLoading]   = useState(false);
  const [data,    setData]      = useState<any>(null);
  const [error,   setError]     = useState<string | null>(null);
  const [paid,    setPaid]      = useState(false);

  const check = async () => {
    if (!address.trim()) return;
    setLoading(true); setData(null); setError(null); setPaid(false);

    try {
      // First call without payment — get the 402 challenge
      const r1 = await fetch(`${apiUrl}/api/v1/reputation/${address.trim()}`);
      if (r1.status === 402) {
        const challenge = await r1.json();
        // Retry with mock payment header (demo mode)
        const r2 = await fetch(`${apiUrl}/api/v1/reputation/${address.trim()}`, {
          headers: { "x-payment": `mock:GDEMO_FRONTEND_USER:${challenge.challenge?.amount_usdc ?? "0.0005"}` },
        });
        if (!r2.ok) {
          const err = await r2.json();
          setError(err.error ?? "Error al consultar reputación");
          return;
        }
        setData(await r2.json());
        setPaid(true);
      } else if (r1.ok) {
        setData(await r1.json());
      } else {
        const err = await r1.json();
        setError(err.error ?? "Error");
      }
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  };

  const rep  = data?.reputation;
  const sig  = data?.agent_signal;
  const merch = data?.merchant;

  const TIER_COLORS: Record<string, string> = {
    maestro: "#4ade80", experto: "#60a5fa", activo: "#fbbf24", espora: "#f87171",
  };
  const tierColor = rep ? (TIER_COLORS[rep.tier] ?? "#9ca3af") : "#9ca3af";

  return (
    <div style={{ fontFamily: "monospace" }}>
      <div style={{ marginBottom: "1.25rem" }}>
        <h2 style={{ margin: "0 0 0.4rem", fontSize: "1.1rem", color: "white" }}>
          ⭐ Reputación de Comercios
        </h2>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "#6b7280", lineHeight: 1.5 }}>
          El agente verifica la reputación on-chain de un comercio antes de enviar al usuario.
          Cada consulta cuesta <span style={{ color: "#4ade80" }}>$0.0005 USDC</span> vía x402.
        </p>
      </div>

      {/* Input */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1.25rem" }}>
        <div>
          <label style={{ fontSize: "0.72rem", color: "#9ca3af", display: "block", marginBottom: "0.4rem" }}>
            Comercios conocidos
          </label>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {KNOWN_MERCHANTS.map(m => (
              <button key={m.address} onClick={() => setAddress(m.address)} style={{
                padding: "0.3rem 0.6rem", fontSize: "0.7rem",
                background: address === m.address ? "#1f2937" : "transparent",
                border: `1px solid ${address === m.address ? "#4ade80" : "#374151"}`,
                color: address === m.address ? "#4ade80" : "#9ca3af",
                borderRadius: "4px", cursor: "pointer",
              }}>{m.label}</button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="G... dirección Stellar del comercio"
            style={{
              flex: 1, padding: "0.5rem 0.75rem", background: "#111827",
              border: "1px solid #374151", borderRadius: "6px",
              color: "white", fontSize: "0.78rem", fontFamily: "monospace",
              outline: "none",
            }}
          />
          <button onClick={check} disabled={loading} style={{
            padding: "0.5rem 1.25rem", background: loading ? "#1f2937" : "#7c3aed",
            color: loading ? "#6b7280" : "white", border: "none",
            borderRadius: "6px", cursor: loading ? "not-allowed" : "pointer",
            fontSize: "0.875rem", fontWeight: "bold", fontFamily: "monospace",
          }}>
            {loading ? "Consultando..." : "⭐ Verificar"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          background: "#1c0a0a", border: "1px solid #7f1d1d",
          borderRadius: "8px", padding: "0.75rem 1rem", marginBottom: "1rem",
          color: "#f87171", fontSize: "0.8rem",
        }}>✗ {error}</div>
      )}

      {/* Result */}
      {data && rep && (
        <div style={{
          background: "#0f172a", border: `1px solid ${sig?.trusted ? "#16a34a" : "#7f1d1d"}`,
          borderRadius: "8px", padding: "1.25rem",
        }}>
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
            <div>
              <div style={{ fontSize: "1rem", fontWeight: "bold", color: "white", marginBottom: "0.2rem" }}>
                {merch?.name}
              </div>
              <div style={{ fontSize: "0.72rem", color: "#9ca3af" }}>📍 {merch?.location}</div>
              <div style={{ fontSize: "0.65rem", color: "#4b5563", marginTop: "0.2rem" }}>
                {data.address?.slice(0,12)}...{data.address?.slice(-8)}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "1.5rem" }}>{rep.tier_emoji}</div>
              <div style={{ fontSize: "0.75rem", color: tierColor, fontWeight: "bold", textTransform: "uppercase" }}>
                {rep.tier}
              </div>
            </div>
          </div>

          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem", marginBottom: "1rem" }}>
            {[
              { label: "Completion", value: rep.completion_percent, color: tierColor },
              { label: "Trades", value: rep.trades_completed, color: "white" },
              { label: "Tiempo promedio", value: `${rep.avg_time_minutes} min`, color: "white" },
              { label: "Volumen total", value: `$${rep.total_volume_usdc} USDC`, color: "#60a5fa" },
              { label: "En red desde", value: new Date(rep.on_chain_since).toLocaleDateString("es-MX"), color: "#9ca3af" },
              { label: "NFT Soulbound", value: rep.nft_soulbound ? rep.nft_soulbound.token_id : "—", color: rep.nft_soulbound ? "#4ade80" : "#4b5563" },
            ].map(s => (
              <div key={s.label} style={{
                background: "#1e293b", borderRadius: "6px", padding: "0.6rem",
              }}>
                <div style={{ fontSize: "0.62rem", color: "#6b7280", marginBottom: "0.2rem" }}>{s.label}</div>
                <div style={{ fontSize: "0.85rem", fontWeight: "bold", color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* NFT note */}
          {rep.nft_soulbound && (
            <div style={{
              background: "#052e16", borderRadius: "6px", padding: "0.5rem 0.75rem",
              marginBottom: "1rem", fontSize: "0.72rem", color: "#86efac",
              border: "1px solid #166534",
            }}>
              🔒 {rep.nft_soulbound.note}
            </div>
          )}

          {/* Agent signal */}
          {sig && (
            <div style={{
              background: sig.trusted ? "#052e16" : "#1c0a0a",
              border: `1px solid ${sig.trusted ? "#16a34a" : "#7f1d1d"}`,
              borderRadius: "6px", padding: "0.75rem",
              fontSize: "0.8rem", color: sig.trusted ? "#4ade80" : "#f87171",
              fontWeight: "bold",
            }}>
              {sig.recommendation}
              <div style={{ fontSize: "0.65rem", fontWeight: "normal", marginTop: "0.2rem", color: sig.trusted ? "#86efac" : "#fca5a5" }}>
                Nivel de riesgo: {sig.risk_level.toUpperCase()}
              </div>
            </div>
          )}

          {/* Payment note */}
          {paid && (
            <div style={{ marginTop: "0.75rem", fontSize: "0.65rem", color: "#4b5563" }}>
              ✓ $0.0005 USDC pagados vía x402 para esta consulta
            </div>
          )}
        </div>
      )}

      {/* Explanation */}
      {!data && !loading && !error && (
        <div style={{
          background: "#111827", border: "1px solid #1f2937",
          borderRadius: "8px", padding: "1rem",
          fontSize: "0.78rem", color: "#6b7280", lineHeight: 1.7,
        }}>
          <div style={{ color: "#9ca3af", fontWeight: "bold", marginBottom: "0.5rem" }}>
            ¿Por qué un agente IA necesita esto?
          </div>
          <div>
            Antes de enviar a un usuario a un desconocido con dinero en efectivo,
            el agente verifica la reputación on-chain del comercio.
            Esta consulta cuesta <span style={{ color: "#4ade80" }}>$0.0005 USDC</span> porque
            es acceso a datos que solo MicoPay tiene:
            trades completados, tasa de éxito, tiempo promedio, y un{" "}
            <span style={{ color: "#a78bfa" }}>NFT soulbound</span> que certifica
            la reputación y no puede ser transferido ni comprado.
          </div>
          <div style={{ marginTop: "0.5rem" }}>
            El agente decide en milisegundos. El humano lo ignoraría. El agente nunca lo olvida.
          </div>
        </div>
      )}
    </div>
  );
}
