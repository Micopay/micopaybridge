import { useEffect, useState } from "react";
import FundWidget from "./components/FundWidget";
import ServiceCatalog from "./components/ServiceCatalog";
import DemoTerminal from "./components/DemoTerminal";
import SwapStatus from "./components/SwapStatus";
import ZKDemoTerminal from "./components/ZKDemoTerminal";
import ReputationPanel from "./components/ReputationPanel";
import BazaarFeed from "./components/BazaarFeed";
import DemoBanner from "./components/DemoBanner";
import ActivationPanel from "./components/ActivationPanel";
import { useDemoStatus } from "./hooks/useDemoStatus";

import { API_URL, APP_URL } from "./config";

type Tab = "demo" | "swap" | "zk" | "bazaar" | "reputation" | "fund" | "services" | "activate";

// No login gate here on purpose: this dashboard is a human observer console
// for the agent economy demo, not something an agent itself ever sees — the
// whole pitch is agents talk to the API directly, no account, no API key.
// (The login screen this used to show was copied from the mobile app's
// App Store review flow, where it does make sense — it doesn't here.)
/**
 * Se muestra cuando el build salió sin `VITE_API_URL`. Dice qué falta y cómo
 * arreglarlo, en vez de dejar siete pestañas que fallan sin explicación.
 */
function ApiNoConfigurada() {
  return (
    <div
      className="min-h-screen bg-gray-950 text-gray-100"
      style={{
        fontFamily: "monospace",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
      }}
    >
      <div style={{ maxWidth: "34rem" }}>
        <p style={{ fontSize: "0.72rem", letterSpacing: "0.14em", color: "#f59e0b", margin: 0 }}>
          CONSOLA SIN API
        </p>
        <h1 style={{ fontSize: "1.35rem", margin: "0.6rem 0 0.9rem", lineHeight: 1.3 }}>
          Esta consola no tiene backend al que llamar
        </h1>
        <p style={{ fontSize: "0.85rem", lineHeight: 1.7, color: "#9ca3af", margin: "0 0 0.9rem" }}>
          Se compiló sin <code style={{ color: "#e5e7eb" }}>VITE_API_URL</code>, así que no hay
          ninguna dirección a la que pedir datos. Los paneles de demo, swap, bazaar y reputación
          dependen todos de la API del bridge (<code style={{ color: "#e5e7eb" }}>apps/api</code>).
        </p>
        <p style={{ fontSize: "0.85rem", lineHeight: 1.7, color: "#9ca3af", margin: "0 0 1.2rem" }}>
          No es un fallo de red ni algo que se arregle recargando: hay que volver a compilar
          indicando la URL.
        </p>
        <pre
          style={{
            background: "#111827",
            border: "1px solid #1f2937",
            borderRadius: "6px",
            padding: "0.85rem",
            fontSize: "0.75rem",
            color: "#a7f3d0",
            overflowX: "auto",
            margin: 0,
          }}
        >
{`VITE_API_URL=https://<api-del-bridge> npm run deploy`}
        </pre>
      </div>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("demo");
  const { isDemoMode } = useDemoStatus();

  // El badge decía "testnet live" fijo, incluso con la API en mainnet. Sale
  // de /health, que es quien sabe en qué red está corriendo de verdad.
  const [network, setNetwork] = useState<string | null>(null);
  useEffect(() => {
    if (!API_URL) return;
    let cancelled = false;
    fetch(`${API_URL}/health`)
      .then((res) => res.json())
      .then((data: { network?: string }) => {
        if (!cancelled) setNetwork(data.network ?? null);
      })
      .catch(() => {
        if (!cancelled) setNetwork(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sin API no hay nada que enseñar: cada panel de abajo vive de llamarla. Más
  // vale decirlo que pintar siete pestañas que fallan en silencio.
  if (!API_URL) return <ApiNoConfigurada />;

  const tabs: { id: Tab; label: string }[] = [
    { id: "demo", label: "⚡ Demo" },
    { id: "swap", label: "🌉 Swap XRPL↔Soroban" },
    { id: "zk", label: "🔐 ZK Access" },
    { id: "bazaar", label: "🕸️ Bazaar" },
    { id: "reputation", label: "⭐ Reputación" },
    { id: "fund", label: "💚 Fund MicoPay" },
    { id: "services", label: "📡 Servicios" },
    { id: "activate", label: "🔑 Activar" },
  ];

  return (
    <div
      className="min-h-screen bg-gray-950 text-gray-100"
      style={{ fontFamily: "monospace" }}
    >
      <DemoBanner isDemoMode={isDemoMode} />
      {/* Header */}
      <header
        style={{
          borderBottom: "1px solid #1f2937",
          padding: "1rem 1.5rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: isDemoMode ? "28px" : undefined,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontSize: "1.5rem" }}>🍄</span>
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: "1.1rem",
                fontWeight: "bold",
                color: "white",
              }}
            >
              MicoPay Protocol
            </h1>
            <p style={{ margin: 0, fontSize: "0.72rem", color: "#6b7280" }}>
              La primera API que da a agentes IA acceso a efectivo físico en
              México · x402 on Stellar
            </p>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.4rem",
          }}
        >
          <div
            style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
          >
            <a
              href="https://gamma.app/docs/Empowering-everyone-through-digital-money-51bfqke37x9sjst?mode=doc"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: "0.72rem",
                color: "#a78bfa",
                textDecoration: "none",
                border: "1px solid #7c3aed",
                borderRadius: "5px",
                padding: "0.25rem 0.6rem",
              }}
            >
              📊 Presentación
            </a>
            {APP_URL && (
              <a
                href={APP_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: "0.72rem",
                  color: "#4ade80",
                  textDecoration: "none",
                  border: "1px solid #16a34a",
                  borderRadius: "5px",
                  padding: "0.25rem 0.6rem",
                }}
              >
                📱 App MicoPay
              </a>
            )}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              fontSize: "0.72rem",
            }}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: "#4ade80",
                display: "inline-block",
              }}
            />
            <span style={{ color: "#4ade80" }}>
              {network === null
                ? "live"
                : network === "PUBLIC"
                  ? "mainnet live"
                  : "testnet live"}
            </span>
            <span style={{ color: "#4b5563" }}>· Sin cuenta · Sin API key</span>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <nav
        style={{
          borderBottom: "1px solid #1f2937",
          padding: "0 1.5rem",
          display: "flex",
          gap: "0.25rem",
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "0.75rem 1rem",
              fontSize: "0.875rem",
              background: "none",
              border: "none",
              borderBottom:
                activeTab === tab.id
                  ? "2px solid #4ade80"
                  : "2px solid transparent",
              color: activeTab === tab.id ? "#4ade80" : "#6b7280",
              cursor: "pointer",
              transition: "color 0.15s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <main style={{ padding: "1.5rem", maxWidth: "900px", margin: "0 auto" }}>
        {activeTab === "demo" && <DemoTerminal apiUrl={API_URL} />}
        {activeTab === "swap" && <SwapStatus apiUrl={API_URL} />}
        {activeTab === "zk" && <ZKDemoTerminal apiUrl={API_URL} />}
        {activeTab === "bazaar" && <BazaarFeed apiUrl={API_URL} />}
        {activeTab === "reputation" && <ReputationPanel apiUrl={API_URL} />}
        {activeTab === "fund" && <FundWidget apiUrl={API_URL} />}
        {activeTab === "services" && <ServiceCatalog apiUrl={API_URL} />}
        {activeTab === "activate" && <ActivationPanel apiUrl={API_URL} />}
      </main>
    </div>
  );
}
