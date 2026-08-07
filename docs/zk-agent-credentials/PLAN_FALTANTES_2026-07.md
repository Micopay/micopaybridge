# Plan de implementación — lo que FALTA (2026-07-02)

> **Entregable 1 de la revisión Fable.** Cubre los pendientes #3 (saldo privado), #4 (set = pagos
> x402 sin emisor) y #5 (Base/CCTP) de [`STATUS.md`](./STATUS.md), verificado contra el código real
> en `main` al 2026-07-02. Complementa (no reemplaza) [`BASE_IMPLEMENTATION_PLAN.md`](./BASE_IMPLEMENTATION_PLAN.md).
> La auditoría que justifica la Fase 0 está en [`AUDIT_2026-07.md`](./AUDIT_2026-07.md).

---

## 0. Verificación de vigencia — qué sigue vivo y qué cambió

Contrasté `BASE_BRIDGE_PLAN.md` (2026-06-16, "definitivo") y `BASE_IMPLEMENTATION_PLAN.md`
(posterior, Base-first) contra el código de hoy:

| Afirmación del plan | Realidad en código (2026-07-02) | Veredicto |
|---|---|---|
| "Tubería ZK mergeada a main" | ✅ `routes/credentials.ts`, `routes/inference.ts`, `lib/zkVerify.ts`, `circuits/access_credential_v1/` existen en `main` | Vigente |
| "x402 middleware solo Stellar XDR + mock" | ✅ `middleware/x402.ts` — cero EIP-3009/Solana/CCTP (`grep viem\|solana\|cctp\|3009` → 0 hits en `src/`) | Vigente — Base sigue en 0% |
| WP7 de BASE_BRIDGE_PLAN: "gatear endpoints con proof de `reputation_v1`" | ⚠️ **Superado.** El gate ya existe pero con otra forma: `access_credential_v1` gatea `/api/v1/inference`. No construir WP7 como está escrito | Obsoleto en su forma; cumplido en espíritu |
| "Replay protection: `db/x402.ts` — reuse para Base" | ⚠️ **El path de DB es código muerto**: `useDatabase` nunca se pone en `true` (`x402.ts:18`), el replay vive en un `Set` en memoria | El plan asume una pieza que hoy no opera |
| Referencias a líneas (`zk.ts L114`, `x402.ts L55-73/L107`) | Aproximadamente correctas todavía | OK |
| CCTP live en Stellar desde mayo 2026; USDC Base Sepolia `0x036C…`; x402 = EIP-3009 en Base | No re-verificado por mí en esta sesión — el doc dice "verified 2026-06-16" | **Re-verificar antes de WP de CCTP** (V1 vs V2, dominios) |
| Solana (~49% del volumen) | Sin código; `BASE_IMPLEMENTATION_PLAN.md` ya lo difirió conscientemente | Vigente como decisión: Base primero |

**Conclusión:** `BASE_IMPLEMENTATION_PLAN.md` sigue siendo el plan operativo correcto para el
pendiente #5, con dos correcciones: (a) eliminar la dependencia de WP7-estilo-reputación, y
(b) **anteponer una Fase 0 de seguridad** — la auditoría encontró que el cobro x402 de Stellar
hoy **no verifica que el pago exista on-chain**, y conectar dinero real de Base sobre esa base
replicaría el hueco con fondos reales.

---

## Fase 0 — Endurecer la base ANTES de conectar dinero real (bloqueante para Base)

> Para el demo con mock puede diferirse parte de esto; para aceptar un solo USDC real (Stellar o
> Base), es bloqueante. Detalle y evidencia por hallazgo: `AUDIT_2026-07.md`.

| WP | Qué | Archivos | Esfuerzo |
|---|---|---|---|
| 0.1 | **Verificar liquidación real del pago Stellar**: hoy `verifyPayment` solo parsea el XDR (ni firma, ni submit, ni consulta de inclusión). Opciones: (a) el server hace submit del XDR y espera SUCCESS, o (b) el cliente manda el hash y el server confirma vía RPC/Horizon que la tx existe, pagó a `PLATFORM_ADDRESS` y es reciente | `middleware/x402.ts` | ~½ día |
| 0.2 | **Gatear `mock:` por entorno** (`X402_ALLOW_MOCK=true` solo en dev/test). Hoy el bypass está activo incondicionalmente | `middleware/x402.ts:110` | ~15 min |
| 0.3 | **Fail-closed del cross-check de raíz en `/inference`**: hoy si el RPC falla, se omite el chequeo y se sirve (el mismo bug que `zk.ts` ya arregló como SEC-08). Copiar el patrón fail-closed | `routes/inference.ts:90-102` | ~30 min |
| 0.4 | **Gobernanza de la raíz**: quitar `setReputationRoot` del camino controlado por el cliente (modo `client_generated` deja que cualquier pagador de 0.01 reemplace la raíz GLOBAL). Mínimo: batch-anchor server-side de commitments recibidos. Ideal: contrato con **multi-root** (map issuer→roots o set de raíces válidas) y chequeo de raíz DENTRO de `verify_unique` | `routes/credentials.ts:54-79`, `contracts/zk-verifier/src/lib.rs` (+redeploy) | 1–2 días |
| 0.5 | **Separación de llaves**: `ADMIN_SECRET_KEY` hoy es admin del contrato (puede registrar VKs maliciosas) + pagador de gas + seteador de raíz, en un server caliente. Separar operador (hot, solo gas) de admin (frío) | `lib/zkVerify.ts`, contrato (rol operador) | ~1 día |
| 0.6 | **Replay store durable**: arreglar `useDatabase` (nunca se activa) y la ventana de expiración de 5 min tras la cual un tx_hash vuelve a ser utilizable | `middleware/x402.ts:18`, `db/x402.ts:38-43` | ~½ día |
| 0.7 | **TTL del nullifier**: `extend_ttl(100_000, 200_000)` ≈ ~12 días de vida; después la garantía burn-once depende de la semántica de archivado. Subir el TTL a años o re-extender; verificar comportamiento de entradas archivadas | `contracts/zk-verifier/src/lib.rs:153` | ~½ día + verificación |

---

## Fase 1 — Aceptar x402 desde Base (pendiente #5, parte 1) · **MVP del demo Base**

Equivale a WP1+WP2 de `BASE_IMPLEMENTATION_PLAN.md`; sigue válido tal cual. Resumen:

1. **WP1 — Config + wallet Base** (~1.5 h): `npm i viem`; vars `BASE_RPC_URL`, `BASE_CHAIN_ID=84532`,
   `BASE_USDC_ADDRESS`, `PLATFORM_BASE_ADDRESS`, `RELAYER_EVM_PRIVATE_KEY`, `X402_FACILITATOR_URL`,
   `X402_ACCEPT_CHAINS`. Archivos: `apps/api/package.json`, `src/config.ts`, `.env.example`.
2. **WP2 — Verificador EIP-3009** (~4–6 h): reto 402 con array `accepts[]` (stellar + base-sepolia);
   en `verifyPayment`, rama para JSON x402 de Base; validar firma → pagador, `to`, `token`, `value`
   (6 decimales, **aritmética entera, no `parseFloat`**), `validBefore`, `chainId`, nonce sin usar
   (requiere WP 0.6); liquidar vía facilitator o self-submit con viem.
   Archivos: `middleware/x402.ts` + nuevo `services/base-payment.service.ts`.

**Dependencias externas:** spec x402 vigente (x402.org — los campos han cambiado antes), dirección
USDC de Base Sepolia (verificar en basescan), decisión facilitator-vs-self-submit (abierta; para
demo, self-submit con relayer de testnet es lo más simple y sin dependencia de Coinbase).

**Gate de verificación:** test de integración con viem mockeado (auth válida → 200; nonce repetido /
underpayment / expirado → 402) + `curl -i` mostrando el `accepts` multi-chain.

Con Fase 1 terminada ya existe el titular mínimo: **"un agente de Base compra una credencial
anónima con USDC vía x402 y la gasta en Stellar"**.

---

## Fase 2 — Gateway: pagar la API x402 de Base (pendiente #5, parte 2)

WP3 del plan Base, válido tal cual (~4–6 h): nuevo `services/base-x402-client.service.ts`; en
`/inference`, tras verificar la credencial, en vez de (o además de) llamar a Anthropic directo,
pagar una API x402 destino en Base con `RELAYER_EVM_PRIVATE_KEY` y relayar la respuesta; registrar
el **recibo `nullifier (Stellar) ↔ tx (Base)`** en Postgres (tabla nueva). Mantener Anthropic
directo como fallback.

**Nota honesta:** para el demo, Anthropic-directo ya cuenta la historia de "consumo"; el pago real a
una API de Base es lo que la vuelve creíble frente al mercado agéntico. Es MVP para el pitch de
producto, nice-to-have para un demo de hackathon.

---

## Fase 3 — Context-binding en el circuito (WP5 — **promovido de opcional a recomendado**)

La auditoría encontró que el proof es hoy un **instrumento al portador**: no está atado ni al
solicitante ni al prompt, así que quien lo observe (logs, red, replay del historial del cliente)
puede adelantarse y gastar la credencial con su propio prompt. Añadir entrada pública
`context = H(recurso, prompt_hash)` al circuito ata cada proof a SU consumo.

- Archivos: `circuits/access_credential_v1/src/main.nr` (+1 input público), regenerar VK (`bb`),
  `register_circuit` de la v2, `lib/zkVerify.ts` y `routes/inference.ts` (validar que el `context`
  recibido corresponde al prompt de la request).
- Esfuerzo: ~½–1 día. Riesgo bajo (patrón ya dominado: VK bytes_and_fields, proof plano keccak).

---

## Fase 4 — CCTP tesorería Base→Stellar (pendiente #5, parte 3)

WP4 del plan Base, válido: nuevo `services/cctp.service.ts`; `depositForBurn` en Base → atestación
Circle → mint en Stellar; **por lotes, nunca por micropago**. Re-verificar antes de empezar:
contratos/dominios CCTP para Stellar, V1 vs V2 (latencia 13–19 min vs segundos), y que la ruta
Base-Sepolia→Stellar-testnet exista en sandbox de Circle (puede que solo mainnet — riesgo real
del demo). Esfuerzo: ~1–1.5 días si testnet existe; si no, demostrar con montos mínimos en mainnet
o mostrar solo el script firmado sin broadcast.

**Para el demo: nice-to-have.** Una transferencia scripteada una sola vez, impresa en consola, basta
como prueba del "motor". Nada del flujo de credenciales depende de CCTP.

---

## Fase 5 — Agente de ejemplo + distribución (WP6)

- `examples/agent/`: agente mínimo con viem que descubre MicoPay, paga x402 en Base Sepolia, genera
  el proof (o lo delega a un helper) y consume `/inference` **sin cuenta de Stellar**. Este es el
  demo titular del lado Base.
- `skill/agentkit.json` o `/.well-known/x402` (verificar formato vigente en x402.org).
- Listar en agentic.market (formato de listing a confirmar). Esfuerzo total: ~½ día.

**Detalle práctico no resuelto en los planes previos:** el agente necesita generar proofs
UltraHonk. Hoy eso requiere `nargo`+`bb` (WSL). Para que un agente real lo haga solo, hace falta
**proving en el cliente** (bb.js/WASM en Node) o un **servicio de proving** (que reintroduce
confianza: el prover ve el secret). Presupuestar ~1–2 días para bb.js en el agente de ejemplo;
sin esto, el "agente autónomo" del demo es en realidad un script asistido.

---

## Pendiente #4 de STATUS — "el set SON los pagos x402" (sin emisor de confianza) · diseño

Hoy el emisor (MicoPay) decide qué hojas entran al árbol. La versión sin confianza: la hoja se
deriva **del propio pago**, y el árbol se construye de datos públicos on-chain que cualquiera puede
recomputar.

- **Mecanismo (Stellar primero):** el pagador incluye `H(secret)` en el pago (memo hash de 32
  bytes). Un indexer (determinista, público) escanea los pagos a `PLATFORM_ADDRESS` con memo-hash y
  construye el árbol; la raíz se publica con referencia al rango de ledgers. Cualquiera puede
  reconstruir el árbol y auditar que su hoja está. El emisor ya no puede excluir ni inflar hojas
  sin que se note.
- **En Base:** el commitment viaja en el `nonce` de EIP-3009 o en calldata/evento del settle — mismo
  patrón, indexer sobre eventos ERC-20/facilitator.
- **Lo difícil:** (a) quién publica la raíz y por qué creerle → mitigación: raíz recomputable +
  ventana de disputa; la versión fuerte (contrato que acumula commitments en un árbol incremental
  on-chain, tipo Tornado) es más trabajo en Soroban pero elimina al publicador; (b) la
  correspondencia 1 pago = 1 hoja la da el propio pago (monto fijo por credencial).
- **Esfuerzo:** indexer + raíz recomputable ≈ 3–5 días. Árbol incremental on-chain ≈ 1–2 semanas.
- **Veredicto:** es el escalón que más impresiona a un juez técnico ("no confíes en nosotros:
  el conjunto es el registro público de pagos"), pero **post-demo**; el MVP narrativo se logra con
  el modo `client_generated` + batch-anchor (Fase 0.4).

## Pendiente #3 de STATUS — saldo privado / range proof · diseño honesto

Probar "mi saldo ≥ precio" y decrementar sin revelar el saldo = **sistema de notas** (como
Zcash/Aztec): cada gasto consume la nota `H(secret, balance)` (nullifier) y **crea una nota nueva**
`H(secret', balance - precio)` cuyo commitment debe **insertarse al árbol on-chain** en la misma
operación.

Implica: circuito nuevo (membership + range proof del balance + binding de la nota de salida),
árbol incremental **on-chain** (inserciones por gasto — ya no basta una raíz estática publicada por
el emisor), y manejo de cambio/estado en el cliente. Esfuerzo realista: **2–4 semanas**, con el
árbol incremental de Soroban como prerequisito compartido con el pendiente #4.

**Veredicto:** es "la forma más pura de la tesis" pero es un producto nuevo, no un incremento. Para
demo y para los primeros clientes, **fichas discretas** (N credenciales de 1 uso) cuentan la misma
historia con lo ya construido. Hacerlo solo cuando haya un usuario que lo pida.

---

## MVP de demo vs nice-to-have (resumen ejecutivo)

| Pieza | ¿MVP demo Base? | ¿Necesario para dinero real? |
|---|---|---|
| Fase 0.2/0.3 (mock gate, fail-closed) | ✅ sí (barato y evita vergüenzas en vivo) | ✅ |
| Fase 0.1/0.4/0.5/0.6/0.7 (pago real, raíz, llaves, replay, TTL) | ⚠️ no bloquea el demo mock | ✅ bloqueante |
| Fase 1 (aceptar EIP-3009 de Base) | ✅ **el corazón del demo Base** | ✅ |
| Fase 2 (pagar API x402 en Base) | ◻️ nice-to-have (Anthropic directo basta) | ✅ para el producto gateway |
| Fase 3 (context-binding) | ◻️ nice-to-have | ✅ (proof al portador = robable) |
| Fase 4 (CCTP) | ◻️ nice-to-have (1 script una vez) | ✅ para tesorería |
| Fase 5 (agente ejemplo + listing) | ✅ la prueba visible | — |
| Pendiente #4 (set = pagos) | ❌ post-demo | diferenciador técnico futuro |
| Pendiente #3 (saldo privado) | ❌ post-demo | producto v2 |

**Camino crítico del demo Base:** 0.2 + 0.3 → Fase 1 → Fase 5 (≈ 2–3 días de trabajo enfocado).
**Camino crítico a producción:** toda la Fase 0 → Fases 1–4 (≈ 2–3 semanas).

## Riesgos principales

| Riesgo | Mitigación |
|---|---|
| Spec x402/EIP-3009 drift | Leer x402.org el día que se empiece WP2; campos aditivos |
| CCTP testnet Base↔Stellar inexistente/limitado | Verificar sandbox Circle ANTES de comprometer el demo con CCTP |
| Proving en cliente (bb.js) más duro de lo esperado | Fallback: script asistido y decirlo honestamente |
| Conectar Base sobre el x402 actual sin Fase 0 | No hacerlo: replica el hueco de "pago no liquidado" con dinero real |
| Raíz global única (una sola por contrato) | Fase 0.4 (multi-root) antes de tener >1 emisor/pool activo |
