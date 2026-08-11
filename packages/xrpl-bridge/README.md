# MicoPay Bridge — Lado XRPL + Relay

Implementación del entregable del hackathon XRPL: espejo del `AtomicSwapHTLC` de Soroban usando **primitivas nativas de XRPL** (sin smart contract), relay de dos ledgers y demo de agentes autónomos. Todo verificado contra **testnets reales** (XRPL testnet + Soroban testnet).

## Estado

| Pieza | Estado | Evidencia |
|---|---|---|
| Primitiva XRPL (EscrowCreate + PREIMAGE-SHA-256 + CancelAfter) | ✅ | `escrow_demo.js` — create + finish `tesSUCCESS` en testnet |
| Traducción criptográfica Soroban ↔ XRPL | ✅ | `bridge-translate.js` + 8 tests (`bridge-translate.test.js`) |
| Relay dos ledgers (nunca custodia) | ✅ | `relay.js` + test en vivo (`relay_test_live.js`) |
| Relay reanudable e idempotente | ✅ | cursor persistido + re-escaneo al arrancar — `relay-state.test.js` 6/6 |
| Swap cross-chain completo | ✅ | `demo_full_swap.js` — corrido en ambas testnets |
| Agentes autónomos (discovery x402 → negociación → ejecución) | ✅ | `agent_a.js` + `agent_b.js` — corrido end-to-end |
| Suite de fallos (8 escenarios de ataque/fallo) | ✅ 8/8 | `failure_suite.js` — ~7 min contra testnets reales |
| Escrow de TOKENS (XLS-85: IOUs, no solo XRP) | ✅ | `test_token_escrow.js` — IOU + condición + finish en testnet |
| RLUSD específicamente | ⏳ bloqueado por Ripple | Emisora testnet (`rQhWct2f...`) sin flag `AllowTrustLineLocking` (verificado on-chain 2026-07-20). Mecanismo listo; entra cuando Ripple active el flag. |

## Infra desplegada

- **AtomicSwapHTLC en Soroban testnet** (compilado tal cual del repo `micopay-protocol`, sin cambios):
  `CANNVHGZHVSVQO76SIVV5YNHH6ODDBV5IEROUITFTFIH6NRLF7XHRCIT`
- SAC nativo (XLM) testnet: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- Identidades stellar CLI locales: `raul-bridge` (iniciador/deployer), `mota-agent` (contraparte)

## La idea en 30 segundos

XRPL ya trae el patrón hashlock/timelock a nivel de ledger: `EscrowCreate` con condición
`PREIMAGE-SHA-256` + `CancelAfter`. No hay contrato que escribir — solo **traducir dos lenguajes**:

1. **Hash**: Soroban valida `sha256(secreto)` crudo; XRPL exige el mismo hash envuelto en
   crypto-condition DER. La condition de XRPL es literalmente `A0258020` + `sha256(secreto)` + `810120`
   — el fingerprint interno ES el hash que valida Soroban. Una sola preimagen gobierna ambas piernas.
2. **Tiempo**: Soroban expira contra ledger sequence (~5s/ledger); XRPL contra época Ripple
   (`unix - 946684800`) vía `CancelAfter`. Ambos se derivan de un margen wall-clock común con la
   invariante estándar: **timeout del iniciador > timeout de la contraparte**.

## Flujo del protocolo (dirección correcta)

```
A (taker)                      B (maker)                      Relay/Watcher
   |-- GET /catalog ------------->|   descubrimiento x402
   |-- POST /swap/propose ------->|   cotización (1 XLM -> 5 XRP)
   |                              |
   |  genera secreto s            |
   |  lock(sha256(s)) en Soroban  |   timeout LARGO
   |-- POST /swap/lock-notify --->|
   |                              |  verifica lock ON-CHAIN
   |                              |  (hash, contraparte, monto, invariante)
   |                              |  EscrowCreate en XRPL, timeout CORTO
   |  verifica escrow ON-CHAIN    |
   |  (condition, destino, monto, |
   |   margen de CancelAfter)     |
   |  EscrowFinish revela s ----->|------------------------------> detecta s
   |                              |  release(s) en Soroban <------ (o notifica a B)
```

Ningún agente confía en mensajes del otro: **toda afirmación se verifica on-chain antes de actuar**.
El relay jamás custodia: solo retransmite una preimagen que ya es pública.

## Cómo correr

Las dependencias se instalan desde la raíz del monorepo (`npm install`); los scripts se
corren desde esta carpeta.

```bash
# 1. Primitiva XRPL sola (2 wallets faucet, escrow condicional)
node escrow_demo.js

# 2. Tests offline (traducción cripto/tiempo + reanudación del relay)
node bridge-translate.test.js
node relay-state.test.js

# 3. Relay en vivo (pierna XRPL + conectividad Soroban RPC)
node relay_test_live.js

# 4. Swap cross-chain completo (necesita stellar CLI + identidades)
node demo_full_swap.js

# 5. Agentes autónomos (dos terminales)
node agent_b.js     # terminal 1 — maker, queda escuchando en :4021
node agent_a.js     # terminal 2 — taker, ejecuta todo el flujo

# 6. Suite de fallos (~7 min, espera timeouts reales)
node failure_suite.js
```

Requisitos: Node ≥ 20, `stellar` CLI con identidades `raul-bridge` y `mota-agent` fondeadas en
testnet (`stellar keys generate <alias> --network testnet --fund`).

## Suite de fallos — qué se prueba

| # | Escenario | Resultado esperado |
|---|---|---|
| 1 | Contraparte desaparece tras el lock de A | `refund()` devuelve fondos tras timeout |
| 2 | Secreto falso en ambas cadenas | Soroban trap en `release`; XRPL `tecCRYPTOCONDITION_ERROR` |
| 3 | B bloquea menos de lo prometido | Guardia de A no encuentra escrow válido → **no revela** |
| 4 | Reclamo después de `CancelAfter` | `tecNO_PERMISSION`; `EscrowCancel` devuelve fondos |
| 5 | Refund antes del timeout | Contrato rechaza (trap en `refund`) |
| 6 | Watcher de B muerto cuando A revela | Re-escaneo de historial (`findRevealedPreimage`) recupera el secreto; B cobra igual |
| 7 | A revela **al filo** del `CancelAfter` de B | La pierna larga en Soroban sigue viva: B cobra igual |
| 8 | Relay reenvía sobre una pierna ya cerrada | No envía tx, no quema fee, saldo intacto |

El #6 es el crítico: sin re-escaneo, un crash del watcher en la ventana entre revelación y reclamo
significa fondos perdidos para B. Con re-escaneo, B tiene todo el margen del timeout del iniciador
para recuperarse.

El #7 caza el bug de traducir el timeout como conversión numérica: si la pierna larga expira antes
de que la corta acabe de liquidarse, quien reveló se queda sin cobrar. Falla en el peor momento
—cuando alguien revela tarde— así que hay que provocarlo a propósito.

## Reanudación del relay

El relay guarda el cursor de Soroban en `relay-state.json` (escritura atómica) y **solo lo avanza
cuando el evento quedó atendido**: si muere a mitad de un `EscrowFinish`, al reiniciar vuelve a
leer el mismo evento. La pierna XRPL no necesita archivo — su cursor es el historial de la cuenta,
que se re-escanea en cada arranque.

Idempotencia: la autoridad es la cadena, no el archivo. El objeto escrow desaparece del ledger al
completarse, así que su ausencia significa "ya no hay nada que hacer" y el relay ni siquiera
manda la transacción. `tecNO_TARGET` (alguien ganó la carrera) se trata como éxito.

## Archivos

- `bridge-translate.js` — traducción cripto/tiempo. DER codificado a mano (36 bytes fulfillment,
  39 condition), validado byte a byte contra `five-bells-condition` en 100 preimágenes aleatorias.
- `relay.js` — `XrplWatcher` (websocket), `SorobanWatcher` (polling `getEvents` del evento
  `released`), `Relay` (orquesta), `findRevealedPreimage` (recuperación tras caída).
- `agent_a.js` / `agent_b.js` — agentes autónomos. Shapes HTTP de `packages/types` del repo
  (`ServiceCatalog`, x402) para enchufar a AIGENTS real después; cobro x402 apagado en demo.
- `demo_full_swap.js` — swap completo guionado (una terminal).
- `failure_suite.js` — los 6 escenarios de arriba contra testnets reales.
- `escrow_demo.js` — la primitiva XRPL mínima.

## Relación con `micopay-protocol`

Este repo es la **implementación de referencia y la suite de fallos** del lado XRPL: scripts
autocontenidos que se corren contra testnets reales sin levantar la API.

**Hoy no existe otra versión de este código.** `micopay-protocol` no tiene pierna XRPL: el
trabajo que vivía en `apps/api/src/services/xrpl.service.ts` y `relay.service.ts` se revirtió
el 2026-07-28 (respaldo en `Micopay Bridge/backup-apps-api-2026-07-28/`). Lo que hay allá es
`ATOMIC_SWAP_CONTRACT_B`: una **segunda instancia de Soroban simulando la cadena B**. Esa pata
falsa es exactamente lo que este repo viene a sustituir.

Del monorepo se usa, sin modificarlo: el contrato `contracts/atomic-swap` (compilado tal cual)
y los shapes HTTP de `packages/types` en los agentes.

## Pendiente / siguiente

- ~~Sustituir `ATOMIC_SWAP_CONTRACT_B` por la pierna XRPL real en la orquestación.~~
  **Hecho** — `apps/api/src/lib/xrpl-leg.ts` consume este paquete y
  `executeAtomicSwapBackground` ya corre las dos piernas de verdad.
  Se prueba con `npm run test:live -w @micopay/api`.
- Integrar los agentes al AIGENTS real — los shapes ya coinciden. Ojo: x402 tiene SEC-13
  (`verifyPayment()` no consulta Horizon) y SEC-14 (anti-replay solo en RAM) abiertos.
- Espejo del `MicopayEscrow` (seller/buyer + fee) sobre las mismas primitivas — el roadmap post-hackathon.
- Empaque de la demo en vivo (script de presentación, explorers abiertos, wallets pre-fondeadas).
