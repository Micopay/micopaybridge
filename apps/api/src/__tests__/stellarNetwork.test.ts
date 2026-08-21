/**
 * El swap y la capa de pago tienen que acabar en la MISMA red.
 *
 * No lo estaban: `lib/soroban.ts` se pasaba a mainnet con `STELLAR_NETWORK=PUBLIC`
 * y `middleware/x402.ts` con `MAINNET`. Con el valor que pone el deploy
 * (`PUBLIC`) el swap movía fondos reales mientras los pagos se verificaban
 * contra Horizon de testnet: pagar con USDC de faucet y recibir un swap real.
 * Con `MAINNET` se invertía y el swap se firmaba con el passphrase equivocado.
 *
 * Cada archivo era coherente consigo mismo, así que nada lo detectaba. Este
 * test mira las dos mitades a la vez, que es donde vivía el fallo.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Networks } from "@stellar/stellar-sdk";

const ORIGINAL = process.env.STELLAR_NETWORK;

/** Recarga el módulo con el entorno actual (se evalúa al importarse). */
async function cargar(valor: string | undefined) {
  if (valor === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = valor;
  const vitest = await import("vitest");
  vitest.vi.resetModules();
  return import("../lib/stellarNetwork.js");
}

beforeEach(() => {
  delete process.env.STELLAR_NETWORK;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = ORIGINAL;
});

describe("red de Stellar — una sola interpretación", () => {
  it("las dos grafías de la red real llevan a mainnet", async () => {
    for (const valor of ["PUBLIC", "MAINNET", "public", "mainnet", " Public "]) {
      const net = await cargar(valor);
      expect(net.IS_MAINNET, `valor ${JSON.stringify(valor)}`).toBe(true);
      expect(net.NETWORK_PASSPHRASE).toBe(Networks.PUBLIC);
      expect(net.HORIZON_URL).toBe("https://horizon.stellar.org");
    }
  });

  it("por defecto, y ante cualquier otra cosa, testnet", async () => {
    for (const valor of [undefined, "TESTNET", "testnet", "", "produccion"]) {
      const net = await cargar(valor);
      expect(net.IS_MAINNET, `valor ${JSON.stringify(valor)}`).toBe(false);
      expect(net.NETWORK_PASSPHRASE).toBe(Networks.TESTNET);
      expect(net.HORIZON_URL).toBe("https://horizon-testnet.stellar.org");
    }
  });

  it("el nombre que se anuncia a los agentes no depende de cómo se escribió", async () => {
    // Va en el reto 402. Si dependiera de la grafía, el mismo despliegue diría
    // "public" o "mainnet" según quién configuró el entorno.
    expect((await cargar("PUBLIC")).NETWORK_NAME).toBe("public");
    expect((await cargar("MAINNET")).NETWORK_NAME).toBe("public");
    expect((await cargar("TESTNET")).NETWORK_NAME).toBe("testnet");
  });

  it("no queda ningún módulo interpretando STELLAR_NETWORK por su cuenta", async () => {
    // La regresión de verdad: el fallo no fue un valor mal escrito, fue que dos
    // archivos decidían la red cada uno por su lado. Que solo lo haga uno.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const raiz = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const culpables: string[] = [];

    const recorrer = (dir: string) => {
      for (const entrada of readdirSync(dir)) {
        const ruta = join(dir, entrada);
        if (statSync(ruta).isDirectory()) {
          if (entrada !== "node_modules" && entrada !== "__tests__") recorrer(ruta);
          continue;
        }
        if (!entrada.endsWith(".ts")) continue;
        if (ruta.endsWith(join("lib", "stellarNetwork.ts"))) continue;
        const texto = readFileSync(ruta, "utf8");
        // Leer la variable para registrarla o mostrarla está bien; lo que no
        // puede hacerse fuera del módulo es COMPARARLA para decidir la red.
        if (/process\.env\.STELLAR_NETWORK\s*===/.test(texto)) {
          culpables.push(ruta.slice(raiz.length));
        }
      }
    };
    recorrer(raiz);

    expect(culpables, `deben usar lib/stellarNetwork.ts: ${culpables.join(", ")}`).toEqual([]);
  });
});
