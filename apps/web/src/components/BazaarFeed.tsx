import { useState, useEffect } from "react";

interface AssetInfo {
  chain: string;
  symbol: string;
  amount: string;
}

interface BazaarIntent {
  id: string;
  agent_address: string;
  offered: AssetInfo;
  wanted: AssetInfo;
  status: "active" | "negotiating" | "executed" | "expired";
  created_at: string;
  reputation_tier?: string;
  secret_hash?: string;
}

interface Props { apiUrl: string; }

export default function BazaarFeed({ apiUrl }: Props) {
  const [intents, setIntents] = useState<BazaarIntent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [broadcastLoading, setBroadcastLoading] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  const fetchFeed = async () => {
    // ... (rest of fetchFeed stays the same, I'll use multi_replace if needed but for now replacing the relevant part)
    setLoading(true);
    try {
      const r1 = await fetch(`${apiUrl}/api/v1/bazaar/feed`);
      if (r1.status === 402) {
        const challenge = await r1.json();
        const r2 = await fetch(`${apiUrl}/api/v1/bazaar/feed`, {
          headers: { "x-payment": `mock:GDEMO_BROWSER_USER:${challenge.challenge?.amount_usdc ?? "0.001"}` },
        });
        const data = await r2.json();
        setIntents(data.intents || []);
      } else {
        const data = await r1.json();
        setIntents(data.intents || []);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const broadcastIntent = async () => {
    // ... (rest of broadcastIntent stays same)
    setBroadcastLoading(true);
    try {
      const r1 = await fetch(`${apiUrl}/api/v1/bazaar/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offered: { chain: "ethereum", symbol: "ETH", amount: "1.2" },
          wanted: { chain: "stellar", symbol: "USDC", amount: "3200" }
        })
      });
      await r1.json();
      await fetch(`${apiUrl}/api/v1/bazaar/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-payment": `mock:GDEMO_AGENT_UI:0.005` },
        body: JSON.stringify({
          offered: { chain: "ethereum", symbol: "ETH", amount: "1.2" },
          wanted: { chain: "stellar", symbol: "USDC", amount: "3200" }
        })
      });
      await fetchFeed();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBroadcastLoading(false);
    }
  };

  const acceptIntent = async (intentId: string) => {
    setAcceptingId(intentId);
    try {
      // Step 1: get challenge for accept
      const r1 = await fetch(`${apiUrl}/api/v1/bazaar/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          intent_id: intentId, 
          quote_id: "qut-demo-123", 
          secret_hash: "0x82a...hash" 
        })
      });
      await r1.json();

      // Step 2: Pay $0.005 and accept
      await fetch(`${apiUrl}/api/v1/bazaar/accept`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-payment": `mock:GDEMO_INITIATOR:0.005`
        },
        body: JSON.stringify({
          intent_id: intentId,
          quote_id: "qut-demo-123"
          // no secret_hash → backend auto-generates a valid 32-byte hash
        })
      });
      
      await fetchFeed();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAcceptingId(null);
    }
  };

  useEffect(() => { fetchFeed(); }, []);

  const TIER_EMOJI: Record<string, string> = {
    maestro: "🍄", experto: "⭐", activo: "✅", espora: "🌱"
  };

  const CHAIN_COLORS: Record<string, string> = {
    ethereum: "#627eea",
    stellar: "#4ade80",
    solana: "#14f195",
    physical: "#fbbf24"
  };

  const STATUS_COLORS: Record<string, string> = {
    active: "#4ade80",
    negotiating: "#60a5fa",
    executed: "#a78bfa",
    expired: "#f87171"
  };

  return (
    <div style={{ fontFamily: "monospace" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
        <div>
          <h2 style={{ margin: "0 0 0.4rem", fontSize: "1.1rem", color: "white" }}>
            🕸️ Agent Bazaar
          </h2>
          <p style={{ margin: 0, fontSize: "0.8rem", color: "#6b7280" }}>
            Social layer where agents broadcast intents using x402 and HTLCs.
          </p>
        </div>
        <button 
          onClick={broadcastIntent}
          disabled={broadcastLoading}
          style={{
            padding: "0.5rem 1rem", background: "#7c3aed", color: "white",
            border: "none", borderRadius: "6px", cursor: "pointer",
            fontSize: "0.75rem", fontWeight: "bold", fontFamily: "monospace"
          }}
        >
          {broadcastLoading ? "Broadcasting..." : "📢 Broadcast Intent ($0.005)"}
        </button>
      </div>

      {error && <div style={{ color: "#f87171", marginBottom: "1rem" }}>✗ {error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {loading && intents.length === 0 ? (
          <div style={{ color: "#374151" }}>Scanning intent layer...</div>
        ) : (
          intents.map((intent) => (
            <div key={intent.id} style={{
              background: "#111827", border: "1px solid #1f2937",
              borderRadius: "10px", padding: "1rem", position: "relative",
              overflow: "hidden", outline: intent.status === 'negotiating' ? '1px solid #60a5fa20' : 'none'
            }}>
              {/* Agent info */}
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                <div style={{ 
                  width: "24px", height: "24px", borderRadius: "50%", 
                  background: "#1e293b", display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "0.8rem"
                }}>
                  {intent.reputation_tier ? TIER_EMOJI[intent.reputation_tier] : "🤖"}
                </div>
                <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                  {intent.agent_address.slice(0, 8)}...{intent.agent_address.slice(-4)}
                </span>
                <span style={{ fontSize: "0.62rem", color: "#4b5563" }}>
                  {new Date(intent.created_at).toLocaleTimeString()}
                </span>
                {intent.status !== 'active' && (
                  <span style={{ 
                    fontSize: "0.55rem", background: STATUS_COLORS[intent.status] + '20', 
                    color: STATUS_COLORS[intent.status], padding: '2px 6px', borderRadius: '4px',
                    textTransform: 'uppercase', letterSpacing: '0.5px'
                  }}>
                    {intent.status}
                  </span>
                )}
              </div>

              {/* Swap visualization */}
              <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "0.62rem", color: "#6b7280", textTransform: "uppercase", marginBottom: "0.2rem" }}>
                    Offered on {intent.offered.chain}
                  </div>
                  <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "white" }}>
                    {intent.offered.amount} <span style={{ color: CHAIN_COLORS[intent.offered.chain] || "#9ca3af" }}>{intent.offered.symbol}</span>
                  </div>
                </div>
                
                <div style={{ color: "#374151", fontSize: "1.2rem" }}>➡️</div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "0.62rem", color: "#6b7280", textTransform: "uppercase", marginBottom: "0.2rem" }}>
                    Wanted on {intent.wanted.chain}
                  </div>
                  <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "white" }}>
                    {intent.wanted.amount} <span style={{ color: CHAIN_COLORS[intent.wanted.chain] || "#9ca3af" }}>{intent.wanted.symbol}</span>
                  </div>
                </div>
              </div>

              {/* Action */}
              <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", alignItems: 'center', gap: '8px' }}>
                {intent.status === 'negotiating' && (
                   <div style={{ fontSize: '0.65rem', color: '#60a5fa', display: 'flex', alignItems: 'center', gap: '4px' }}>
                     <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#60a5fa', display: 'inline-block' }} />
                     Handshake sealed. Hash shared.
                   </div>
                )}
                <button 
                  disabled={intent.status !== 'active' || acceptingId === intent.id}
                  onClick={() => acceptIntent(intent.id)}
                  style={{
                    padding: "0.4rem 0.8rem", 
                    background: intent.status === 'active' ? "transparent" : "#1f2937",
                    border: `1px solid ${intent.status === 'active' ? "#374151" : "#111827"}`, 
                    color: intent.status === 'active' ? "#9ca3af" : "#4b5563",
                    borderRadius: "5px", fontSize: "0.65rem", cursor: intent.status === 'active' ? "pointer" : "not-allowed",
                    fontFamily: "monospace"
                  }}
                >
                  {acceptingId === intent.id ? "Sealing..." : intent.status === 'active' ? "🤝 Quote / Accept" : "Negotiating..."}
                </button>
              </div>

              {/* Status bar */}
              <div style={{
                position: "absolute", bottom: 0, left: 0, width: "3px", 
                height: "100%", background: STATUS_COLORS[intent.status] || "#374151"
              }} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
