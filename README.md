# MicoPay Bridge — Lado XRPL + Relay

Implementación del entregable del hackathon XRPL: espejo del `AtomicSwapHTLC` de Soroban usando **primitivas nativas de XRPL** (sin smart contract), relay de dos ledgers y demo de agentes autónomos. Todo verificado contra **testnets reales** (XRPL testnet + Soroban testnet).

## Estado

| Pieza | Estado | Evidencia |
|---|---|---|
| Primitiva XRPL (EscrowCreate + PREIMAGE-SHA-256 + CancelAfter) | ✅ | `escrow_demo.js` — create + finish `tesSUCCESS` en testnet |
| Traducción criptográfica Soroban ↔ XRPL | ✅ | `bridge-translate.js` + 8 tests (`bridge-translate.test.js`) |
| Relay dos ledgers (nunca custodia) | ✅ | `relay.js` + test en vivo (`relay_test_live.js`) |
| Swap cross-chain completo | ✅ | `demo_full_swap.js` — corrido en ambas testnets |
| Agentes autónomos (discovery x402 → negociación → ejecución) | ✅ | `agent_a.js` + `agent_b.js` — corrido end-to-end |
| Suite de fallos (6 escenarios de ataque/fallo) | ✅ 6/6 | `failure_suite.js` — 5.5 min contra testnets reales |
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

```bash
npm install

# 1. Primitiva XRPL sola (2 wallets faucet, escrow condicional)
node escrow_demo.js

# 2. Tests del módulo de traducción (offline)
node bridge-translate.test.js

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

El #6 es el crítico: sin re-escaneo, un crash del watcher en la ventana entre revelación y reclamo
significa fondos perdidos para B. Con re-escaneo, B tiene todo el margen del timeout del iniciador
para recuperarse.

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

El código que atiende usuarios vive en el producto, no aquí:
`micopay-protocol/apps/api/src/services/xrpl.service.ts` (primitivas HTLC) y
`relay.service.ts` (observador XRPL → release en Soroban). Cuando las dos versiones
difieran, **manda la de `apps/api`**; este repo documenta el porqué y prueba los bordes.

## Pendiente / siguiente

- Integrar los agentes al AIGENTS real (`apps/api`) — los shapes ya coinciden.
- Espejo del `MicopayEscrow` (seller/buyer + fee) sobre las mismas primitivas — el roadmap post-hackathon.
- Empaque de la demo en vivo (script de presentación, explorers abiertos, wallets pre-fondeadas).
