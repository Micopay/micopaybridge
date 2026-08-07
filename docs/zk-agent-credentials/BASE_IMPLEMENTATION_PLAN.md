# Plan de implementación — Lado Base (puente Base ↔ Stellar)

> **Objetivo:** que un agente que vive en **Base** pague en USDC (x402), consuma un recurso
> (inferencia de un mercado agéntico en Base) **gateado por su credencial ZK en Stellar**, y que el
> valor se asiente en Stellar vía **CCTP** — sin que el agente toque Stellar.
>
> Estrategia y "por qué": [`BASE_BRIDGE_PLAN.md`](./BASE_BRIDGE_PLAN.md). Estado global:
> [`STATUS.md`](./STATUS.md). Este doc es el **cómo construirlo desde donde estamos hoy**.

---

## 0. Punto de partida (lo que YA existe)

- ✅ Tubería ZK en Stellar: comprar (`/api/v1/credentials/buy`) → gastar (`/api/v1/inference`) →
  Claude. Multi-usuario + commitment del cliente. Mergeado a `main`.
- ✅ Middleware x402: `apps/api/src/middleware/x402.ts` — hoy solo entiende **Stellar (XDR) + `mock:`**.
- ✅ Verificación on-chain: `apps/api/src/lib/zkVerify.ts` (`invokeVerify`, `setReputationRoot`).
- ❌ **Falta TODO el lado Base:** aceptar x402 en Base, wallet de Base, pagar APIs de Base, CCTP.

### Reglas que no se re-litigan
- **El agente vive single-chain (Base).** Nunca toca Stellar, nunca tiene wallet de Stellar.
- **MicoPay es multi-chain:** wallet en Base (cobrar, pagar APIs, CCTP) + cuenta en Stellar (ZK).
- **NO custodia:** cobramos por nuestro servicio + pagamos APIs con nuestro dinero (patrón AWS/Stripe).
  El único punto regulado (efectivo/pesos) es Fase 2, aparte.
- **NO hacer CCTP por micropago.** Los fees se acumulan en Base; CCTP es para tesorería/montos grandes.
- **Testnet siempre** (Base Sepolia + Stellar testnet). Nunca loggear llaves; nunca auto-broadcast sin flag.

---

## Work packages

### WP1 — Config multi-chain + wallet de Base · ~1.5 h · bajo riesgo
**Archivos:** `apps/api/package.json`, `apps/api/src/config.ts`, `apps/api/.env.example`.
1. `npm i viem` (cliente EVM).
2. `.env.example`:
   ```env
   X402_ACCEPT_CHAINS=stellar,base
   BASE_RPC_URL=https://sepolia.base.org
   BASE_CHAIN_ID=84532
   BASE_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e   # Base Sepolia USDC (verificar)
   PLATFORM_BASE_ADDRESS=        # 0x... donde caen los pagos x402 del agente
   RELAYER_EVM_PRIVATE_KEY=      # testnet — firma settle de EIP-3009 / CCTP burns
   X402_FACILITATOR_URL=         # opcional: facilitator de Coinbase; si no, self-submit
   ```
3. Leerlos en `config.ts` (espejo de las vars de Stellar).
**Verify:** `npx tsc --noEmit` limpio; `viem` importa; la wallet de Base existe y está fondeada (USDC + ETH de gas en Sepolia).

### WP2 — Aceptar x402 en Base (EIP-3009) · ~4–6 h · medio · CORE
**Archivo:** `apps/api/src/middleware/x402.ts` (hoy: `mock:` + XDR Stellar).
1. En el reto 402, emitir un array `accepts: []` con **stellar-usdc** + **`exact` en base-sepolia**
   (esquema EIP-3009). Gatear por `X402_ACCEPT_CHAINS`. Mantener los campos legacy (aditivo).
2. En `verifyPayment`, ramificar el header `X-PAYMENT`: `mock:` → XDR Stellar → **base64 JSON x402 de Base**.
3. Verificar la autorización **EIP-3009 (`transferWithAuthorization`)**: firma recupera al pagador,
   `to == PLATFORM_BASE_ADDRESS`, `token == BASE_USDC_ADDRESS`, `value ≥` requerido (**6 decimales**),
   `validBefore` no expirado, `chainId == BASE_CHAIN_ID`, `nonce` no usado (replay con `db/x402.ts`).
4. Liquidar: POST al `X402_FACILITATOR_URL` **o** self-submit `transferWithAuthorization` con viem; confirmar.
5. Adjuntar el pagador `0x...` como `request.payerAddress` (los handlers quedan agnósticos a la cadena).
**Verify:** test de integración (viem mockeado, espejo de `__tests__/zk.test.ts`): auth válida → 200;
nonce repetido → 402; underpayment → 402; expirado → 402. Y `curl -i` a un endpoint pago → 402 cuyo
`accepts` lista base + stellar.

### WP3 — Gateway: pagar APIs x402 de Base (la inferencia real) · ~4–6 h · medio · CORE
**Nuevo:** `apps/api/src/services/base-x402-client.service.ts`; usar en `routes/inference.ts`.
1. Generalizar `/api/v1/inference`: tras verificar la credencial ZK (ya existe), en vez de llamar
   a Anthropic directo, **pagar la API x402 destino en Base** desde `PLATFORM_BASE_ADDRESS` (firmar
   EIP-3009 con `RELAYER_EVM_PRIVATE_KEY`) y relayar la respuesta. (Mantener el modo "Anthropic
   directo" como fallback/demo.)
2. **Recibo:** registrar `nullifier (Stellar) ↔ tx de Base` (la capa de liquidación auditable).
**Verify:** llamar `/inference` con credencial válida → se hace un pago x402 en Base testnet → respuesta
relayada; el recibo liga nullifier↔tx.

### WP4 — CCTP tesorería Base→Stellar · ~1–1.5 días · medio
**Nuevo:** `apps/api/src/services/cctp.service.ts`.
1. Transferencia USDC nativa **Base→Stellar**: `depositForBurn` en Base → atestación de Circle → mint
   en Stellar. Verificar contratos/dominios CCTP + **V1 vs V2** (latencia).
2. **Por lotes**, no por llamada (mover saldos acumulados / montos grandes). Los micro-fees se quedan
   en Base como ingreso.
**Verify:** script que mueve USDC Base→Stellar en testnet; imprime tx de Stellar + monto.

### WP5 — (Opcional) `context`-binding credencial↔recurso · ~½ día · circuito + VK
**Archivos:** `circuits/access_credential_v1/src/main.nr` (+ regenerar VK + re-registrar).
- Añadir entrada pública `context = H(target_api, nonce)` para **atar el gasto a ESE recurso** (que
  una prueba para "API X" no sirva para "API Y"). Es el enlace criptográfico credencial↔consumo.
**Verify:** una prueba con `context` de API X falla si se presenta para API Y.

### WP6 — Agente de ejemplo + discovery · ~3–4 h · bajo
**Nuevo:** `examples/agent/` + `skill/agentkit.json` (o `/.well-known/x402`).
1. Un agente mínimo (viem) que: descubre MicoPay, paga x402 en **Base**, y consume la inferencia
   gateada por credencial ZK **end-to-end, sin cuenta de Stellar**. Este ES el demo titular.
2. Listar MicoPay en **agentic.market** (distribución donde están los agentes).
**Verify:** `examples/agent` corre e2e contra la API local + testnets.

---

## Orden de ejecución
1. **WP1 → WP2** (aceptar pago de Base — desbloquea todo).
2. **WP3** (gateway que paga la API de Base — la historia completa).
3. **WP6** (agente demo + listing — la prueba visible).
4. **WP4** (CCTP — el motor de valor) · **WP5** (context-binding, si hay tiempo).

**Camino crítico para el demo:** WP1 + WP2 + WP3 + WP6. (CCTP y context refuerzan, no bloquean el demo.)

## Definición de "hecho" (Fase 1 Base)
- [ ] Un agente paga x402 USDC en **Base** para desbloquear un endpoint de MicoPay (WP2).
- [ ] `/inference` paga la API de inferencia en Base por cuenta del agente, gateado por credencial ZK (WP3).
- [ ] Recibo `nullifier ↔ tx de Base`.
- [ ] CCTP Base→Stellar demostrado en testnet (WP4).
- [ ] `examples/agent` consume e2e **sin cuenta de Stellar** (WP6).
- [ ] `tsc` + tests verdes; flujos de Stellar intactos; sin secretos en logs; sin custodia de fondos de terceros.

## Riesgos y caveats honestos
| Riesgo | Mitigación |
|---|---|
| x402 spec cambia de campos | Leer x402.org antes de WP2/WP3; mantener campos Stellar aditivos |
| Latencia CCTP (~min en V1) | Verificar V2/fast; acumular (no bridge por llamada) |
| USDC 6 decimales (Base) | Escalado explícito en WP2/WP3; tests de borde |
| Derivar a custodia | WP2/WP3 solo cobran por NUESTRO servicio; efectivo a terceros = Fase 2 |
| Dependencia de plataforma (Coinbase facilitator) | Stellar es el core; Base es canal, no el hogar |
| Mercado inflado por meme-coins | El volumen real de consumo de API < titulares; apuntar a demanda real (inferencia) |

## Decisiones abiertas
1. **Self-submit EIP-3009 vs facilitator de Coinbase** (WP2).
2. **CCTP V1 vs V2** en Base→Stellar (latencia → promesa de UX).
3. **¿context-binding ahora o después?** (WP5) — barato y ata el consumo al recurso.
4. ¿Solana también? (≈ mitad del volumen agente) — el `BASE_BRIDGE_PLAN.md` lo contempla; este plan se enfoca en Base primero.
