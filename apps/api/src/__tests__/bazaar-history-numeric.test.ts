import { describe, it, expect } from "vitest";
// Sin mock de db/bazaar.js a proposito: lo que se prueba es la funcion real.
import { normalizarHistorial } from "../db/bazaar.js";

/**
 * pg devuelve los NUMERIC como string. AgentHistoryRow.volume_usdc promete
 * number, y upsertAgentHistory hace `existing.volume_usdc + updates.volume_usdc`.
 *
 * Comprobado contra PostgreSQL 16 real antes de este arreglo: con 4500.00 en
 * la fila, sumarle 42 producia "4500.00" + 42 = "4500.0042", que DECIMAL(20,2)
 * redondea de vuelta a 4500.00 — el incremento se perdia entero y en silencio.
 */
describe("normalizarHistorial: los NUMERIC de pg llegan como string", () => {
  const filaComoLaDevuelvePg = {
    agent_address: "GAGENTE",
    broadcasts: 12,
    swaps_completed: 9,
    swaps_cancelled: 0,
    volume_usdc: "4500.00" as unknown as number,
    first_seen: "2026-01-01T00:00:00Z",
    last_active: "2026-01-01T00:00:00Z",
  };

  it("convierte volume_usdc a number, para que sumar sea sumar", () => {
    const fila = normalizarHistorial({ ...filaComoLaDevuelvePg })!;

    expect(typeof fila.volume_usdc).toBe("number");
    expect(fila.volume_usdc).toBe(4500);
    // Esto era "4500.0042" antes del arreglo
    expect(fila.volume_usdc + 42).toBe(4542);
  });

  it("un valor ilegible cae a 0, no a NaN", () => {
    const fila = normalizarHistorial({ ...filaComoLaDevuelvePg, volume_usdc: null as unknown as number })!;
    expect(fila.volume_usdc).toBe(0);
  });

  it("null sigue siendo null", () => {
    expect(normalizarHistorial(null)).toBeNull();
  });
});
