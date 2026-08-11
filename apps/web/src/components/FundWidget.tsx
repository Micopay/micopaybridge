import { useState, useEffect, useCallback } from "react";

interface FundStats {
  total_funded_usdc: string;
  total_supporters: number;
  total_transactions: number;
  recent: Array<{
    address: string;
    amount_usdc: string;
    message?: string;
    timestamp: string;
    stellar_expert_url: string;
  }>;
}

interface Props {
  apiUrl: string;
}

export default function FundWidget({ apiUrl }: Props) {
  const [stats, setStats] = useState<FundStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/v1/fund/stats`);
      if (res.ok) {
        const data = await res.json();
        setStats(data);
        setLastUpdate(new Date());
      }
    } catch {
      // API not reachable — show mock data
      setStats({
        total_funded_usdc: "12.50",
        total_supporters: 8,
        total_transactions: 11,
        recent: [
          {
            address: "GABC...XYZ1",
            amount_usdc: "1.00",
            message: "Great project, keep building!",
            timestamp: new Date().toISOString(),
            stellar_expert_url: "https://stellar.expert/explorer/testnet/tx/demo1",
          },
          {
            address: "GDEF...XYZ2",
            amount_usdc: "5.00",
            message: "x402 is the future",
            timestamp: new Date(Date.now() - 60000).toISOString(),
            stellar_expert_url: "https://stellar.expert/explorer/testnet/tx/demo2",
          },
        ],
      });
      setLastUpdate(new Date());
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 5000); // poll every 5s
    return () => clearInterval(interval);
  }, [fetchStats]);

  const box: React.CSSProperties = {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: "0.5rem",
    padding: "1.5rem",
    marginBottom: "1rem",
  };

  const statBox: React.CSSProperties = {
    background: "#0f172a",
    border: "1px solid #1f2937",
    borderRadius: "0.375rem",
    padding: "1rem",
    textAlign: "center",
  };

  return (
    <div>
      {/* Hero */}
      <div style={box}>
        <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem", color: "white" }}>
          Fund Micopay — The Meta-Demo
        </h2>
        <p style={{ margin: 0, fontSize: "0.875rem", color: "#9ca3af", lineHeight: "1.6" }}>
          Any agent pays x402 → funds this project → dashboard updates live → tx verifiable on-chain.
          <br />
          <strong style={{ color: "#4ade80" }}>10 seconds. No API key. No signup.</strong>
        </p>
      </div>

      {/* Stats */}
      {loading ? (
        <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>Loading stats...</p>
      ) : stats ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem", marginBottom: "1rem" }}>
            <div style={statBox}>
              <div style={{ fontSize: "2rem", fontWeight: "bold", color: "#4ade80" }}>
                ${stats.total_funded_usdc}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.25rem" }}>USDC funded</div>
            </div>
            <div style={statBox}>
              <div style={{ fontSize: "2rem", fontWeight: "bold", color: "#60a5fa" }}>
                {stats.total_supporters}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.25rem" }}>supporters</div>
            </div>
            <div style={statBox}>
              <div style={{ fontSize: "2rem", fontWeight: "bold", color: "#a78bfa" }}>
                {stats.total_transactions}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.25rem" }}>transactions</div>
            </div>
          </div>

          {/* Live feed */}
          <div style={box}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h3 style={{ margin: 0, fontSize: "0.875rem", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Live Feed
              </h3>
              {lastUpdate && (
                <span style={{ fontSize: "0.75rem", color: "#4b5563" }}>
                  updated {lastUpdate.toLocaleTimeString()}
                </span>
              )}
            </div>

            {stats.recent.length === 0 ? (
              <p style={{ color: "#4b5563", fontSize: "0.875rem", margin: 0 }}>
                No contributions yet. Be the first!
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {stats.recent.map((tx, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      padding: "0.75rem",
                      background: "#0f172a",
                      borderRadius: "0.375rem",
                      gap: "1rem",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <code style={{ fontSize: "0.75rem", color: "#60a5fa" }}>{tx.address}</code>
                        <span style={{ fontSize: "0.875rem", fontWeight: "bold", color: "#4ade80" }}>
                          +${tx.amount_usdc}
                        </span>
                      </div>
                      {tx.message && (
                        <p style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "#9ca3af" }}>
                          "{tx.message}"
                        </p>
                      )}
                      <p style={{ margin: "0.25rem 0 0", fontSize: "0.7rem", color: "#4b5563" }}>
                        {new Date(tx.timestamp).toLocaleTimeString()}
                      </p>
                    </div>
                    <a
                      href={tx.stellar_expert_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: "0.7rem", color: "#a78bfa", whiteSpace: "nowrap", textDecoration: "none" }}
                    >
                      view tx ↗
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* How to fund */}
          <div style={box}>
            <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Fund via x402
            </h3>
            <pre style={{ margin: 0, fontSize: "0.75rem", color: "#d1d5db", overflowX: "auto", lineHeight: "1.8" }}>
{`# Step 1: Get payment challenge
curl -X POST ${apiUrl}/api/v1/fund

# Step 2: Pay and resend (min 0.10 USDC)
curl -X POST ${apiUrl}/api/v1/fund \\
  -H "X-Payment: <signed_stellar_xdr>" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Keep building!"}'`}
            </pre>
          </div>
        </>
      ) : null}
    </div>
  );
}
