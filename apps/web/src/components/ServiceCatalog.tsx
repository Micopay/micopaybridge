import { useState, useEffect } from "react";

interface Service {
  name: string;
  endpoint: string;
  method: string;
  price_usdc: string;
  description: string;
}

interface Catalog {
  protocol: string;
  version: string;
  payment_method: string;
  services: Service[];
  skill_url: string;
}

interface Props {
  apiUrl: string;
}

export default function ServiceCatalog({ apiUrl }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${apiUrl}/api/v1/services`)
      .then((r) => r.json())
      .then(setCatalog)
      .catch(() => setCatalog(null))
      .finally(() => setLoading(false));
  }, [apiUrl]);

  const box: React.CSSProperties = {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: "0.5rem",
    padding: "1.5rem",
    marginBottom: "1rem",
  };

  const METHOD_COLORS: Record<string, string> = {
    GET: "#4ade80",
    POST: "#60a5fa",
  };

  if (loading) return <p style={{ color: "#6b7280" }}>Loading catalog...</p>;

  return (
    <div>
      <div style={box}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.25rem", color: "white" }}>Service Catalog</h2>
            {catalog && (
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#6b7280" }}>
                protocol: {catalog.protocol} v{catalog.version} · payment: {catalog.payment_method} (USDC on Stellar)
              </p>
            )}
          </div>
          {catalog && (
            <a
              href={catalog.skill_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "0.75rem", color: "#a78bfa", textDecoration: "none", whiteSpace: "nowrap" }}
            >
              SKILL.md ↗
            </a>
          )}
        </div>

        {!catalog ? (
          <p style={{ color: "#f87171", fontSize: "0.875rem" }}>API not reachable. Start the API server.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {catalog.services.map((svc) => (
              <div key={svc.name} style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                padding: "0.875rem",
                background: "#0f172a",
                borderRadius: "0.375rem",
                gap: "1rem",
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem", flexWrap: "wrap" }}>
                    <span style={{
                      padding: "0.1rem 0.35rem",
                      borderRadius: "0.2rem",
                      fontSize: "0.65rem",
                      fontWeight: "bold",
                      color: METHOD_COLORS[svc.method] ?? "#9ca3af",
                      background: "#1f2937",
                    }}>
                      {svc.method}
                    </span>
                    <code style={{ fontSize: "0.8rem", color: "#e5e7eb" }}>{svc.endpoint}</code>
                  </div>
                  <p style={{ margin: 0, fontSize: "0.75rem", color: "#9ca3af" }}>{svc.description}</p>
                </div>
                <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {svc.price_usdc === "0" || svc.price_usdc === "free" ? (
                    <span style={{ fontSize: "0.75rem", color: "#4ade80" }}>free</span>
                  ) : (
                    <span style={{ fontSize: "0.875rem", fontWeight: "bold", color: "#facc15" }}>
                      ${svc.price_usdc}
                    </span>
                  )}
                  {svc.price_usdc !== "0" && svc.price_usdc !== "free" && (
                    <div style={{ fontSize: "0.65rem", color: "#4b5563" }}>per request</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* x402 explainer */}
      <div style={box}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          How x402 works
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {[
            { step: "1", text: "Request arrives without payment → 402 + challenge" },
            { step: "2", text: "Agent builds Stellar USDC payment tx to pay_to address" },
            { step: "3", text: "Agent signs tx, puts XDR in X-Payment header" },
            { step: "4", text: "Resend request → 200 with data" },
          ].map(({ step, text }) => (
            <div key={step} style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
              <span style={{
                minWidth: "1.5rem",
                height: "1.5rem",
                borderRadius: "50%",
                background: "#166534",
                color: "#4ade80",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.75rem",
                fontWeight: "bold",
              }}>
                {step}
              </span>
              <span style={{ fontSize: "0.875rem", color: "#d1d5db", paddingTop: "0.1rem" }}>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
