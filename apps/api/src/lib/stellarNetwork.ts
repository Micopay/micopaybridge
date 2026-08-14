/**
 * Qué red de Stellar usa el proceso. Una sola fuente para todo el servicio.
 *
 * Antes cada módulo interpretaba `STELLAR_NETWORK` por su cuenta y **no
 * coincidían**: `lib/soroban.ts` se pasaba a mainnet con el valor `"PUBLIC"` y
 * `middleware/x402.ts` con `"MAINNET"`. No existía ningún valor que pusiera a
 * los dos en la red real:
 *
 *   STELLAR_NETWORK=PUBLIC   → el swap movía fondos reales, pero los pagos se
 *                              verificaban contra Horizon de TESTNET: se pagaba
 *                              con USDC de juguete y se recibía un swap real.
 *   STELLAR_NETWORK=MAINNET  → los pagos iban bien, pero el swap se firmaba con
 *                              el passphrase de testnet y la red lo rechazaba.
 *
 * Cada archivo era coherente consigo mismo, así que ni el typecheck ni los
 * tests lo veían: las suites corren con el valor por defecto, donde ambos
 * coinciden en testnet. La contradicción solo aparecía con dinero real de por
 * medio.
 *
 * Se aceptan las dos grafías a propósito — `PUBLIC` es como llama Stellar a su
 * red real y es lo que ya usa el deploy; `MAINNET` es lo que esperaba x402 y lo
 * que la gente escribe por costumbre. Rechazar una de las dos convertiría este
 * arreglo en otra forma del mismo fallo.
 */
import { Networks } from "@stellar/stellar-sdk";

const CRUDO = (process.env.STELLAR_NETWORK ?? "TESTNET").trim().toUpperCase();

/** Grafías que significan "la red real". */
const NOMBRES_MAINNET = new Set(["PUBLIC", "MAINNET"]);

export const IS_MAINNET: boolean = NOMBRES_MAINNET.has(CRUDO);

/** Passphrase con el que se firman las transacciones. */
export const NETWORK_PASSPHRASE: string = IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;

export const HORIZON_URL: string = IS_MAINNET
  ? "https://horizon.stellar.org"
  : "https://horizon-testnet.stellar.org";

/**
 * Nombre canónico. Va en el reto 402 que leen los agentes, así que no puede
 * depender de cómo se escribiera la variable: el mismo despliegue anunciaría
 * "public" o "mainnet" según el humor de quien configuró el entorno.
 */
export const NETWORK_NAME: "public" | "testnet" = IS_MAINNET ? "public" : "testnet";
