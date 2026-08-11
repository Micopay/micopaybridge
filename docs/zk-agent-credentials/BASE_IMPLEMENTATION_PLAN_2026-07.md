# Plan de implementación — Wallet de Base + demo completa + mercados agénticos

> **Para:** revisión de Fable antes de implementar.
> **Estado: REVISADO por Fable (2026-07-02).** Veredicto: arquitectura wallet fría/caliente, orden
> WP1→WP5 y framing correctos. Este doc ya incorpora los 4 hallazgos de la revisión (marcados
> **[REV-1]**…**[REV-4]** en el texto) y las respuestas a las preguntas de §5. Listo para implementar.
> **Objetivo de este doc:** llevar el lado Base de MicoPay de "no existe nada" a una demo completa:
> un agente en **Base** paga x402, MicoPay lo gatea con una credencial **ZK en Stellar/Soroban**, y
> queda descubrible/consumible desde los mercados agénticos de Base (agentic.market / x402).
>
> **Este doc actualiza y consolida** [`BASE_IMPLEMENTATION_PLAN.md`](./BASE_IMPLEMENTATION_PLAN.md)
> (WP1–WP6, 2026-06-16) a la realidad de hoy — no lo reemplaza como estrategia, lo pone al día contra
> el código actual. Estrategia completa (por qué Base+Solana, por qué Stellar es el hub, framing de
> hackathon): [`BASE_BRIDGE_PLAN.md`](./BASE_BRIDGE_PLAN.md). Estado del pipeline ZK:
> [`STATUS.md`](./STATUS.md). Hallazgos de seguridad ya resueltos: [`AUDIT_2026-07.md`](./AUDIT_2026-07.md).

---

## 0. Punto de partida (verificado contra el código, no contra memoria vieja)

**Lo que YA existe y funciona (Stellar, e2e):**
- Pipeline ZK completo: `POST /api/v1/credentials/buy` (x402) → credencial anónima → `POST
  /api/v1/inference` (gasto con prueba ZK, nullifier quemado on-chain) → Claude responde.
- Contrato `ZkVerifierRegistry` en Stellar testnet: `CBOWU3OVOPGN3ME2R7EFK2Z2JZY4XYRB6A3HBTQ2Q2WWPSXK3VREUQC7`
  (pendiente de **redeploy** — ver más abajo, el WASM cambió esta semana).
- Middleware x402 (`apps/api/src/middleware/x402.ts`) — hoy **solo entiende Stellar (XDR) + `mock:`**.
  Nada de Base existe todavía: `viem`, `BASE_RPC_URL`, `PLATFORM_BASE_ADDRESS`, etc. no están en el
  repo (verificado con grep, cero resultados).

**Fase 0 (auditoría de seguridad, prerequisito de este plan) — CERRADA esta sesión:**
| WP | Qué se arregló |
|---|---|
| 0.1 | Los pagos Stellar ahora se someten y se confirma su liquidación real on-chain (antes solo se parseaba el XDR) |
| 0.2 | El bypass `mock:` de x402 requiere `X402_MOCK_MODE=true` explícito fuera de producción |
| 0.3 | Si el RPC falla al leer la raíz Merkle on-chain, se rechaza (503) en vez de dejar pasar sin validar |
| 0.4 | `credentials.ts` ya no deja que un cliente pagador sobreescriba la raíz global compartida con un árbol propio (`ALLOW_CLIENT_ROOTS`, off por defecto) |
| 0.5 | Separada `OPERATOR_SECRET_KEY` (paga gas en cada verify, sin permisos de contrato) de `ADMIN_SECRET_KEY` (solo `register_circuit`/`set_reputation_root`, uso infrecuente) |
| 0.6 | El replay-store de pagos en Postgres funciona de verdad (antes caía silenciosamente a memoria) |
| 0.7 | TTL de nullifiers subido al máximo real de la red (3,110,400 ledgers ≈ 180 días, confirmado contra testnet vía `stellar network settings`) + `refresh_nullifier()` como keeper hook |

Contrato reconstruye limpio (7 funciones exportadas, incl. `refresh_nullifier`), 9/9 tests Rust pasan,
tests de `apps/api` pasan (mismos 3 archivos con fallos preexistentes no relacionados). **Nada de esto
está commiteado ni redeployado todavía** — es el estado justo antes de empezar el trabajo de Base, para
no construir la integración nueva sobre las mismas fallas que Fable señaló.

**Implicación para este plan:** cualquier pieza nueva del lado Base (relayer key, wallet de
tesorería, verificación de pagos EIP-3009) debe nacer aplicando las mismas lecciones de Fase 0 desde
el diseño, no como parche después. Ver §2 WP1 y §5.

---

## 1. Qué pide el usuario, desglosado

> "crea el plan de implementación para crear la billetera de base y todo lo necesario para tener la
> demo completa y conectarnos a los mercados agénticos de base"

1. **La billetera de Base** — provisionar las claves/direcciones EVM que MicoPay necesita (§2 WP1).
2. **Todo lo necesario para la demo completa** — aceptar x402 en Base, gatear con la credencial ZK ya
   construida en Stellar, y que un agente real complete el flujo de punta a punta (§2 WP2–WP4).
3. **Conectarnos a los mercados agénticos de Base** — que MicoPay sea descubrible y usable por agentes
   que ya viven en el ecosistema x402/agentic.market de Base (§2 WP5).

---

## 2. Work packages

### WP1 — Wallet de Base + config multi-chain · ~1.5–2 h · bajo riesgo
**Archivos:** `apps/api/package.json`, `apps/api/src/config.ts`, `apps/api/.env.example`.

**Diseño de la wallet (aplicando la lección de WP 0.5 — separar caliente de fría desde el día uno):**
- **`PLATFORM_BASE_ADDRESS`** — dirección que RECIBE los pagos x402 de los agentes (destino de
  `transferWithAuthorization`). Es la "tesorería" del lado Base. No necesita firmar nada por sí misma
  en el camino caliente.
- **Liquidación: facilitator PRIMERO, relayer como fallback** *(decisión de la revisión de Fable —
  responde la pregunta abierta de §5)*: el facilitator de x402.org soporta Base Sepolia gratis,
  elimina la clave caliente y el fondeo de ETH, y es el flujo que los agentes del ecosistema x402 ya
  esperan. Camino primario del demo: `X402_FACILITATOR_URL` configurado, **sin** relayer key.
  Condición innegociable: aunque el facilitator liquide, **la verificación del payload (firma, to,
  token, value, ventana temporal) la hacemos nosotros** — el facilitator se usa para settle, no se le
  confía la verificación.
- **`RELAYER_EVM_PRIVATE_KEY`** (fallback, solo si el facilitator no está disponible) — clave que
  SOLO paga gas para someter la transacción `transferWithAuthorization`
  a Base (el agente firma la autorización off-chain; alguien tiene que broadcastear). Es la clave
  caliente, de alta frecuencia, análoga al `OPERATOR_SECRET_KEY` de Stellar. **No debe ser la misma
  clave que controla `PLATFORM_BASE_ADDRESS`** — si el proceso que corre el relayer se compromete, el
  atacante solo puede gastar gas de Sepolia, no mover el USDC acumulado en tesorería. El relayer nunca
  custodia: solo broadcastea una autorización cuyo destino y monto van firmados por el pagador y no
  puede alterar.
- Cuentas Base Sepolia nuevas (generar con `viem` o `cast wallet new`), fondeadas por separado:
  - Tesorería (`PLATFORM_BASE_ADDRESS`): USDC de prueba (faucet Circle) — no necesita ETH de gas.
  - Relayer (`RELAYER_EVM_PRIVATE_KEY`, solo si se usa el fallback self-submit): ETH de Sepolia
    (faucet) para gas — no necesita tener USDC.

**Pasos:**
1. `cd apps/api && npm i viem`.
2. Generar las dos cuentas (script de un solo uso, no comiteado — mismo patrón que se usó para las
   llaves de demo de MicoPay: nunca loggear el secreto, nunca commitear `.env`).
3. Fondear ambas en Base Sepolia (ETH: faucet de Base; USDC: faucet de Circle para Base Sepolia).
4. `.env.example`:
   ```env
   X402_ACCEPT_CHAINS=stellar,base
   BASE_RPC_URL=https://sepolia.base.org
   BASE_CHAIN_ID=84532
   BASE_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e   # verificar en basescan antes de usar
   PLATFORM_BASE_ADDRESS=        # 0x... tesorería — recibe pagos x402, SIN clave caliente en el server
   X402_FACILITATOR_URL=https://x402.org/facilitator   # PRIMARIO: liquida sin clave caliente propia
   RELAYER_EVM_PRIVATE_KEY=      # FALLBACK self-submit — solo paga gas, sin USDC propio; vacío si hay facilitator
   ```
5. Leer estas vars en `config.ts` (mismo patrón que las vars de Stellar).

**Verify:** `npx tsc --noEmit` limpio; `viem` importa; las dos direcciones existen on-chain (balance
ETH > 0 en el relayer, balance USDC > 0 en la tesorería, verificable con `cast balance` / basescan).

---

### WP2 — Aceptar x402 en Base (EIP-3009) · ~6–8 h · medio · CORE
**Archivos:** `apps/api/src/middleware/x402.ts`, `apps/api/src/db/x402.ts`, migración SQL nueva.

0. **[REV-1] Migración del replay-store ANTES de tocar el middleware.** `x402_payments.tx_hash` es
   `VARCHAR(64)` y no aguanta la clave de Base: un nonce EIP-3009 es bytes32 → `0x` + 64 hex = 66
   caracteres, más el namespace son ~110. Migración: `ALTER TABLE x402_payments ALTER COLUMN tx_hash
   TYPE VARCHAR(120)` (o `TEXT`). Ojo: la tabla ya existe en el Postgres de Render, así que el
   `CREATE TABLE IF NOT EXISTS` inline de `db/x402.ts` NO la altera solo — hay que (a) crear la
   migración real, (b) actualizar el CREATE inline de `db/x402.ts` y (c) actualizar
   `db/migrations/001_initial_schema.sql` para que instalaciones nuevas queden consistentes.
   (`payer_address VARCHAR(56)` sí aguanta un `0x…` de 42 chars — no tocar.)
1. En el reto 402 (hoy solo emite el shape Stellar), emitir el **shape canónico x402 a nivel raíz**
   (`x402Version` + `accepts: []`) con **stellar-usdc** + **`exact` en base-sepolia** (esquema
   EIP-3009 canónico — leer x402.org antes de fijar los nombres de campo, la spec puede haber
   cambiado desde 2026-06-16). **No anidar `accepts` dentro del objeto `challenge` legacy**: los
   clientes x402 existentes (paquetes npm oficiales) parsean el shape estándar, y la interop de WP5
   depende de eso. El objeto `challenge` de Stellar se conserva como campo hermano (aditivo, no rompe
   nada existente). Gatear por `X402_ACCEPT_CHAINS`.
2. En `verifyPayment`, ramificar `X-PAYMENT`: `mock:` (ya gateado por `X402_MOCK_MODE`, WP 0.2) → XDR
   Stellar (ya existe) → **base64 JSON del esquema Base**.
3. Verificar la autorización EIP-3009 (`transferWithAuthorization`):
   - **[REV-4] la firma se verifica recuperando al firmante sobre el dominio EIP-712 construido POR
     EL SERVIDOR** con `BASE_CHAIN_ID` y `verifyingContract = BASE_USDC_ADDRESS` pinneados (name/version
     del contrato USDC real, verificar en basescan). Esto enforcea chainId y token de un solo golpe —
     el chainId NO es un campo de la autorización, vive en el domain separator; nunca construir el
     dominio con datos que manda el cliente (mismo espíritu que SEC-A1: aceptar el dominio del cliente
     es aceptar un lookalike),
   - la firma recupera al pagador (`from`) declarado,
   - `to == PLATFORM_BASE_ADDRESS`,
   - `value ≥` el mínimo requerido — **[REV-4] comparar como `BigInt` en unidades base** contra
     `minAmount × 10^6` (**USDC de Base tiene 6 decimales**, no 7 como XLM). NO copiar el patrón
     `parseFloat` del camino Stellar al lado EVM,
   - **[REV-4] `validAfter ≤ now` Y `validBefore > now`** — EIP-3009 tiene ambos límites, no solo
     expiración,
   - `nonce` no usado — reusar `db/x402.ts` (ya es un store durable desde WP 0.6) para el replay.
     **[REV-2] La clave es `base:<from>:<nonce>`**, no solo el nonce: on-chain USDC hace único el par
     *(authorizer, nonce)* — dos pagadores distintos pueden usar legítimamente el mismo nonce. La
     clave del DB debe calcar la semántica del contrato.
4. **[REV-3] Reserva atómica ANTES de liquidar** (cierra una carrera de doble gasto que el camino
   Stellar tiene hoy): el orden `isPaymentUsed → verificar → liquidar → markPaymentUsed` deja pasar
   dos requests **concurrentes** con el mismo `X-PAYMENT` — ambos pasan el check inicial y el fallback
   "si el submit falla, checar si ya liquidó" convierte al segundo en 200 → dos credenciales por un
   pago. El camino Base nace con el orden invertido:
   1. `INSERT … ON CONFLICT DO NOTHING` con la clave `base:<from>:<nonce>` — si no insertó fila, 402
      inmediato (otro request ya la reservó o ya se gastó);
   2. liquidar (paso 5);
   3. si la liquidación falla definitivamente, **borrar la reserva** para no quemar el pago del agente.
   Retrofitear el mismo patrón al camino Stellar es deseable pero no bloquea este plan — dejarlo
   anotado como WP 0.8 pendiente.
5. Liquidar: `POST` al `X402_FACILITATOR_URL` (camino primario, ver WP1) — verificando nosotros el
   payload ANTES de mandarlo, el facilitator solo liquida; si no está configurado, self-submit
   `transferWithAuthorization` con `viem` firmando con `RELAYER_EVM_PRIVATE_KEY`; esperar confirmación
   real on-chain antes de devolver 200 (mismo principio que SEC-C1 en Stellar: no basta con que la
   firma sea válida, hay que ver que liquidó).
6. Adjuntar el pagador `0x...` como `request.payerAddress` — los handlers (`inference.ts`, `zk.ts`)
   quedan agnósticos a la cadena, ya reciben `payerAddress` como string opaco.

**Verify:** test de integración con `viem` mockeado (espejo de `__tests__/zk.test.ts` y del nuevo
`__tests__/credentials.test.ts`): auth válida → 200; nonce repetido (mismo `from`) → 402; mismo nonce
con `from` distinto → 200 (REV-2); dos requests concurrentes con el mismo header → exactamente un 200
(REV-3); underpayment → 402; `validBefore` vencido → 402; `validAfter` futuro → 402; firma sobre otro
chainId u otro token → 402 (REV-4). `curl -i` a un endpoint pago → 402 cuyo `accepts` canónico lista
`base` y `stellar`.

---

### WP3 — El gate ZK ya existe, solo hay que conectarlo · ~1–2 h · bajo riesgo
**Archivo:** `apps/api/src/routes/inference.ts` (no crear uno nuevo — ya hace exactamente esto para
Stellar).

`inference.ts` ya: valida la prueba ZK, cruza la raíz on-chain (fail-closed desde WP 0.3), quema el
nullifier vía `verify_unique`, y solo entonces sirve el recurso (Claude). **No depende de qué cadena
pagó** — ya recibe `payerAddress` de forma agnóstica. El único cambio real es que, tras WP2, un agente
puede llegar a comprar la credencial (`/credentials/buy`) pagando en Base en vez de Stellar/`mock:`.

**Verify:** comprar una credencial pagando con la wallet de Base (WP1+WP2) → gastarla en `/inference`
con una prueba ZK válida → Claude responde y el nullifier queda quemado on-chain en Stellar. Confirma
que "agente paga en Base, gatea con ZK en Stellar" funciona de punta a punta sin tocar `inference.ts`.

---

### WP4 — Agente de ejemplo (la demo en sí) · ~3–4 h · bajo riesgo
**Nuevo:** `examples/agent/` + `skill/agentkit.json` (o `/.well-known/x402`, verificar formato en
x402.org / AgentKit antes de fijar el esquema).

1. Un agente mínimo en TypeScript (`viem`) que:
   - descubre MicoPay (`GET /skill.md` o el descriptor x402),
   - paga x402 en Base Sepolia con USDC de prueba (firma EIP-3009, sin relayer propio — usa el
     `X402_FACILITATOR_URL` si existe, o construye el flujo directo),
   - recibe la credencial anónima,
   - genera la prueba ZK (`nargo`/`bb`, mismo flujo manual documentado en `STATUS.md`),
   - la gasta en `/inference` y muestra la respuesta de Claude.
2. Este agente **nunca toca una cuenta de Stellar** — ese es el punto del demo: paga en Base, y
   MicoPay hace la magia de trust+settlement en Stellar por detrás.

**Verify:** `examples/agent` corre de punta a punta contra la API local + Base Sepolia + Stellar
testnet, sin intervención manual salvo generar el proof (documentar el paso manual de `nargo`/`bb`
como limitación conocida del demo, no como bloqueante).

---

### WP5 — Conectarnos a los mercados agénticos de Base · ~2–3 h · bajo riesgo · distribución
**Archivos:** `apps/api/src/routes/services.ts`, `skill/SKILL.md`, listing externo.

1. `services.ts`: agregar `payment_networks: ["stellar","base"]` y documentar el shape de pago de Base
   junto al de Stellar. Bump de `version`.
2. `SKILL.md`: sección "para agentes en Base" — cómo pagar, qué credencial reciben, cómo la gastan.
3. Registrar el servicio ZKaaS/`credential_buy` de MicoPay en **agentic.market** (confirmar su formato
   de listing/discovery vigente antes de enviar — puede haber cambiado desde 2026-06-16).

**Verify:** `curl /api/v1/services | grep base`; el servicio aparece en la búsqueda/discovery de
agentic.market y es invocable end-to-end con x402 desde ahí (no solo listado — probado).

**Estado (2026-07-02):** 1 y 2 hechos y comiteados (`services.ts` v1.3.0 con `payment_networks:
["stellar","base"]` + entradas `credential_buy`/`inference`; `SKILL.md` con sección "Paying from
Base"). El paso 3 (registro externo) **investigado, no ejecutado** — requiere una instancia
públicamente desplegada (no localhost) con las wallets de Base fondeadas, ninguna de las dos
condiciones se cumple todavía. Hallazgos de la investigación:
- **agentic.market indexa automáticamente** cuando el **facilitator de Coinbase CDP** procesa un
  pago en un endpoint con la "Bazaar discovery extension" habilitada — sin registro manual
  separado. Esto implicaría apuntar `X402_FACILITATOR_URL` al facilitator de CDP en vez del
  genérico `https://x402.org/facilitator` que dejamos como default en WP1 — decisión pendiente,
  no confirmé la URL exacta del facilitator de CDP para Base Sepolia ni el flag de la extensión
  Bazaar (la documentación de CDP no la expone en las páginas que pude leer).
- **Alternativa manual:** `x402-list.com` tiene un link "[submit yours]" de auto-servicio en su
  directorio — más simple, no depende de qué facilitator uses.
- Ninguna opción tiene sentido hoy: no hay URL pública que un indexador externo pueda alcanzar,
  y sin fondeo no hay pagos reales que demostrar. Ejecutar este paso cuando: (a) WP1 esté fondeado,
  (b) haya una URL pública real sirviendo esto (Render u otro).

---

## 3. Orden de ejecución

0. **Commitear la Fase 0 primero** *(agregado en la revisión)* — hoy hay ~25 archivos modificados sin
   commit. Construir WP1–WP5 encima de un working tree así hace imposible revisar el diff de Base por
   separado. Un commit de Fase 0 (+ redeploy del contrato, ver §5) antes de la primera línea de Base.
1. **WP1 → WP2** — sin esto no hay nada que demostrar (crear la wallet, aceptar el pago).
2. **WP3** — casi gratis, es cablear lo que ya existe.
3. **WP4** — la demo visible, lo que se le enseña a un juez o a Fable.
4. **WP5** — distribución; no bloquea el demo pero es lo que responde literalmente "conectarnos a los
   mercados agénticos".

**Camino crítico de la demo completa: WP1 → WP2 → WP3 → WP4.** WP5 es la pieza de "mercados
agénticos" explícita que pidió el usuario — depende de que WP1–WP4 funcionen primero, pero no es
técnicamente parte del camino de pago→gate→respuesta.

---

## 4. Definición de "hecho"

- [ ] Wallet de Base provisionada: tesorería (`PLATFORM_BASE_ADDRESS`) fondeada; si se usa el
      fallback self-submit, el relayer (`RELAYER_EVM_PRIVATE_KEY`) es una cuenta **distinta** con su
      propio ETH de gas.
- [ ] Migración del replay-store aplicada (REV-1): `tx_hash` ensanchado en la migración, en el CREATE
      inline de `db/x402.ts` y en `001_initial_schema.sql`; clave de Base = `base:<from>:<nonce>`
      (REV-2); reserva atómica antes de liquidar con test de concurrencia verde (REV-3).
- [ ] Un agente paga x402 USDC en Base (EIP-3009 real, no mock) y recibe una credencial anónima de
      MicoPay.
- [ ] Esa credencial se gasta con una prueba ZK en `/inference`; el nullifier se quema on-chain en
      Stellar/Soroban; Claude responde.
- [ ] `examples/agent` corre el flujo completo sin que el agente toque Stellar en ningún momento.
- [ ] MicoPay es descubrible y invocable desde agentic.market (o el directorio vigente equivalente).
- [ ] `tsc --noEmit` + `npm test` verdes; flujos de Stellar existentes intactos; ningún secreto en
      logs; el relayer de Base nunca controla fondos de terceros (solo paga gas / cobra por servicio
      propio, mismo principio no-custodial que Fase 0 dejó explícito para Stellar).

---

## 5. Riesgos y preguntas abiertas — RESPONDIDAS en la revisión de Fable (2026-07-02)

| Riesgo / pregunta | Resolución |
|---|---|
| Spec de x402 puede haber cambiado desde 2026-06-16 | Sigue abierto (operativo, no de diseño): releer x402.org / agentic.market antes de fijar los nombres de campo en WP2/WP4/WP5. La dirección de USDC en Base Sepolia del plan (`0x036C…F7e`) coincide con la documentada por Circle — igual verificar en basescan |
| USDC de Base = 6 decimales, no 7 | Resuelto en WP2 paso 3 (REV-4): comparación `BigInt` en unidades base, nunca `parseFloat`, con tests de borde |
| ¿Facilitator de Coinbase para no tener clave caliente propia? | **Sí — facilitator como camino PRIMARIO** (ver WP1): soporta Base Sepolia gratis, elimina `RELAYER_EVM_PRIVATE_KEY` y el fondeo de ETH. Condición: la verificación del payload es nuestra, el facilitator solo liquida. Self-submit queda como fallback documentado |
| ¿El framing no-custodial se sostiene en Base? | **Sí.** `transferWithAuthorization` mueve fondos del pagador directo a la tesorería como pago por servicio propio — comercio, no transmisión de dinero de terceros. El relayer nunca custodia: broadcastea una autorización cuyo destino y monto van firmados por el pagador y no puede alterar. Mismo razonamiento que `AUDIT_2026-07.md` para Stellar, con la ventaja de que en Base el pago ni siquiera puede desviarse |
| Contrato ZK pendiente de redeploy (WP 0.7 cambió el WASM) | Confirmado + endurecido: redeploy, re-registro de circuitos y re-publicación de raíz van en el paso 0 de §3, junto con **commitear la Fase 0** (hoy sin commit) — todo ANTES de la primera línea de Base |
| ¿Solana también? | Confirmado diferir: Base primero (pedido explícito), Solana como fase siguiente per `BASE_BRIDGE_PLAN.md` |

**Hallazgos nuevos de la revisión (no estaban en el borrador):**

| # | Hallazgo | Dónde quedó |
|---|---|---|
| REV-1 | `x402_payments.tx_hash VARCHAR(64)` no aguanta la clave de Base (nonce bytes32 = 66 chars + namespace); la tabla ya existe en Render, el `CREATE IF NOT EXISTS` no la altera | WP2 paso 0 (migración) |
| REV-2 | La clave de replay debe ser `base:<from>:<nonce>` — on-chain USDC hace único el par *(authorizer, nonce)*, no el nonce solo | WP2 paso 3 |
| REV-3 | Carrera de doble gasto con requests concurrentes (el fallback "ya liquidó" convierte al segundo en 200) — el camino Base nace con reserva atómica antes de liquidar; retrofitear Stellar = WP 0.8 pendiente | WP2 paso 4 |
| REV-4 | chainId/token se enforcean vía el dominio EIP-712 construido por el servidor (no son campos sueltos); falta `validAfter`; `value` se compara como BigInt | WP2 paso 3 |

---

**Revisión de diseño completada (Fable, 2026-07-02).** No se ha escrito código de Base todavía — la
auditoría llegó antes que el código, como se pretendía. Respuestas a las tres preguntas del borrador:
el modelo de wallet caliente/fría es correcto (y con facilitator-primero la clave caliente desaparece
del camino feliz); a la verificación EIP-3009 le faltaban `validAfter`, el framing de dominio EIP-712
y la comparación BigInt (corregido en WP2); el framing no-custodial se sostiene en Base. Siguiente
paso: §3 paso 0 (commit de Fase 0 + redeploy), luego WP1.
