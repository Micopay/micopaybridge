# Plan — grabar la demo (guion + apps/web)

> **Para:** revisión de Fable antes de grabar.
> **Objetivo:** llevar `apps/web` (el dashboard del hackathon de Agents pasado) de "no tiene nada
> del pipeline ZK" a un click-through grabable que siga el guion ya escrito en
> [`NARRATIVA_VENDIBLE_2026-07.md`](./NARRATIVA_VENDIBLE_2026-07.md) §6, con transacciones reales
> on-chain — mismo estándar de honestidad que el resto del proyecto: nada de mocks en la grabación
> final.

---

## 0. Punto de partida (verificado contra el código)

**`apps/web` ya existe** — es el dashboard del hackathon de Agents (DoraHacks), un tablero de tabs
(`App.tsx`, estado `activeTab`) con componentes ya funcionando: `DemoTerminal.tsx` (terminal falsa
que corre un demo REAL contra `POST /api/v1/demo/run`), `ServiceCatalog.tsx` (lee `GET
/api/v1/services` en vivo), `BazaarFeed`, `ReputationPanel`, `FundWidget`.

**`POST /api/v1/demo/run`** (`apps/api/src/routes/demo.ts`) es el patrón a copiar: una cuenta de
Stellar testnet fondeada (`DEMO_AGENT_SECRET_KEY`) firma y somete pagos x402 REALES en secuencia
(bazaar → cash_agents → reputation → cash_request → fund), cada paso devuelve `tx_hash` +
`stellar_expert_url`, y `DemoTerminal.tsx` los va imprimiendo como si fuera una terminal. **Nada
mockeado — transacciones reales en testnet**, verificables en el explorador.

**Lo que NO existe:** ningún componente ni endpoint de demo para el pipeline ZK (`credential_buy` →
`inference`). `apps/web` es enteramente anterior a ese trabajo. Tampoco existe nada para Base.

**El guion ya está escrito** — `NARRATIVA_VENDIBLE_2026-07.md` §6 tiene los 4 actos (problema
visible → comprar ficha → gastar en anónimo → reintento rechazado → cierre), con timing (2–3 min) y
las frases exactas para jueces no técnicos. Este plan es **el "cómo" técnico para que ese guion se
pueda grabar de verdad**, no reescribe el guion.

---

## 1. Decisión de scope: ¿Stellar solo, o también Base?

`HACKATHON.md` dice explícitamente que Base es roadmap, **no** parte de la demo. Desde ese doc, sí
construimos la aceptación de pagos en Base (WP1–WP5, código completo y probado) — pero **las wallets
siguen sin fondear** (pendiente, a tu ritmo). Recomendación: **grabar la toma principal 100% Stellar**
(coherente con `HACKATHON.md`, cero riesgo de que un faucet no responda a mitad de grabación), y solo
si las wallets quedan fondeadas ANTES de grabar, hacer una segunda toma corta mostrando el mismo flujo
pagado desde Base con `examples/agent/`. No bloquear la grabación principal esperando el fondeo.

---

## 2. Work packages

### WP-D1 — Generar UN proof ZK real de antemano (fixture) · ~30–45 min · bajo riesgo
Generar en vivo durante la grabación es fresco pero fresco es dependencias frágiles (WSL2, nargo, bb).
Se ejecuta una vez, ahora, con las herramientas manuales ya documentadas en `STATUS.md`:
1. Comprar UNA credencial del pool demo (`POST /credentials/buy`, modo B).
2. `nargo execute witness` + `bb prove` con esa credencial → proof real de `access_credential_v1`.
3. Guardar `{ proof_b64, public_inputs }` como fixture — **no** el secret/witness, solo lo que un
   verificador necesita — en `apps/api/demo/zk_demo_proof.json` (mismo patrón que
   `credential_pool.json`).
**Verify:** ese proof, sometido manualmente a `/api/v1/inference` una vez, responde `200` con
Claude; sometido una segunda vez, responde `409 NullifierAlreadyUsed`. Confirma que el fixture es
válido antes de construir el endpoint de demo sobre él.

### WP-D2 — `POST /api/v1/demo/run-zk` · ~2–3 h · medio riesgo
**Nuevo, en `apps/api/src/routes/demo.ts`** (mismo archivo, mismo patrón que `run` — no un sistema
paralelo). Secuencia real, sin mocks:
1. **Comprar** — `POST /credentials/buy` (x402 real: usar `DEMO_AGENT_SECRET_KEY` igual que el demo
   existente, un pago XDR real de Stellar, NO `mock:`). Devuelve la credencial + tx hash del pago +
   tx hash de anclaje de la raíz (si aplica).
2. **Gastar** — `POST /inference` con el proof fijo de WP-D1 (no el de la credencial recién
   comprada — esa la usa un usuario real después; el fixture es SIEMPRE el mismo, ya validado).
   Responde `200` con la respuesta real de Claude + el tx hash del `verify_unique` en Soroban.
3. **Reintentar** — el MISMO proof del paso 2, otra vez. Responde `409` con
   `NullifierAlreadyUsed` — esto es determinista y no depende de timing real, es la misma llamada
   repetida en la misma request.
Cada paso devuelve el mismo shape que ya usa `DemoResult` (`tx_hash`, `stellar_expert_url` o
`soroban_explorer_url`, `result`) para que el frontend nuevo reutilice `DemoTerminal.tsx` casi tal
cual.
**Verify:** `curl -X POST /api/v1/demo/run-zk` en local devuelve los 3 pasos con tx hashes reales
verificables en stellar.expert / el explorador de Soroban.

### WP-D3 — Componente de frontend `ZKDemoTerminal.tsx` · ~1–2 h · bajo riesgo
**Nuevo,** copiando `DemoTerminal.tsx` case por case (mismo layout de terminal falsa + tarjetas de
pasos), apuntado a `run-zk` en vez de `run`. Textos de los 3 pasos alineados al guion de
`NARRATIVA_VENDIBLE §6`:
- Paso 1 (Comprar): *"El agente compra acceso. Este pago es público — un pago no tiene nada que
  esconder."*
- Paso 2 (Gastar): *"El agente demuestra que tiene una ficha válida y la gasta, sin decir cuál ni
  quién es."* — este es el momento "wow", dar más tiempo/énfasis visual.
- Paso 3 (Reintentar): *"La ficha se quemó. Un uso, nunca dos."*
Agregar un tab nuevo `"zk"` en `App.tsx` (mismo patrón que los tabs existentes) con label tipo
"🔐 ZK Access".
**Verify:** correr `apps/web` local contra `apps/api` local, click en el tab nuevo, click en
"Ejecutar Demo", ver los 3 pasos con links reales al explorador.

### WP-D4 — Guion final de grabación (screen + narración) · ~1 h · bajo riesgo
Combinar el guion de actos de `NARRATIVA_VENDIBLE §6` con direcciones de pantalla concretas contra
el `apps/web` ya actualizado:
```
0:00–0:10  Contexto hablado (sin pantalla, o pantalla del explorador x402 público de
           agentic.market — "mira, se ve todo lo que compra este agente")
0:10–0:40  Tab "Services" → mostrar el catálogo, resaltar que cada endpoint es x402
0:40–1:10  Tab "ZK Access" → click "Ejecutar Demo" → Paso 1 (Comprar) imprime en la
           terminal, link a stellar.expert clickeable en vivo
1:10–1:50  Paso 2 (Gastar) imprime → mostrar la respuesta de Claude + el tx de
           verify_unique en el explorador de Soroban — ESTE es el clímax, pausar aquí
1:50–2:10  Paso 3 (Reintentar) → 409 NullifierAlreadyUsed en pantalla
2:10–2:30  Cierre hablado (las 3 frases de NARRATIVA_VENDIBLE §7)
```
**Verify:** un ensayo completo, cronometrado, sin cortes de edición — si no cabe en 2:30–3:00 real,
recortar el paso 1 (comprar) a menos texto en pantalla, no el paso 2 (el clímax).

---

## 3. Restricciones y riesgos

| Riesgo | Mitigación |
|---|---|
| **Pool demo = 4 credenciales — corregido tras probar WP-D2 en vivo: la restricción real NO es la asignación en memoria (`allocated`, que sí se resetea al reiniciar), es que cada spend exitoso quema su nullifier ON-CHAIN, PARA SIEMPRE — reiniciar `apps/api` no da credenciales frescas, solo resetea qué índice del pool te toca la próxima vez.** Índices #0 (5001) y #1 (5002) ya están quemados (uno durante la validación de WP-D1, otro durante la prueba en vivo de `run-zk`). Queda `zk_demo_proof.json` = índice #2 (5003), sin gastar, y el índice #3 (5004) de reserva. **Total: 1 fixture listo + 1 de repuesto — cero margen para "ensayar" corriendo `run-zk` de más.** Antes de la toma final: correr solo UNA VEZ, en la grabación real. Si hace falta ensayar el flujo de pantalla/timing, hacerlo con el servidor apagado o interceptando la respuesta (no pegándole al endpoint real). |
| El fixture de WP-D1 usa SIEMPRE el mismo nullifier | Correcto y buscado — el paso 3 (reintento) depende de que sea el mismo proof que el paso 2. No regenerar el fixture entre ensayos. |
| Contrato ZK fue redeployado esta semana (`CCZHC456...EITXB2`) | El fixture de WP-D1 debe generarse CONTRA el contrato actual — si se generó antes del redeploy, hay que regenerarlo. Verificar `ZK_VERIFIER_CONTRACT_ID` en `.env` antes de WP-D1. |
| `DEMO_AGENT_SECRET_KEY` necesita USDC real en Stellar testnet para los pagos del paso 1 | Verificar saldo antes de grabar — mismo requisito que ya tiene `/api/v1/demo/run` hoy. |
| Base sin fondear | No bloquea — ver §1, toma principal es Stellar-only. |

---

## 4. Definición de "hecho"

- [ ] Fixture de proof real generado y validado (WP-D1): un `200` y luego un `409` confirmados a mano.
- [ ] `POST /api/v1/demo/run-zk` corre en local con 3 pasos reales, tx hashes verificables.
- [ ] Tab "ZK Access" en `apps/web` corre el flujo completo con un click, con los mismos tx hashes.
- [ ] Ensayo cronometrado completo, sin cortes, cabe en la ventana de tiempo objetivo (2:30–3:00).
- [ ] `apps/api` reiniciado (pool de credenciales fresco) inmediatamente antes de la toma final.
- [ ] Guion final (WP-D4) impreso/a la vista durante la grabación, con timestamps.

## 5. Preguntas abiertas para Fable

1. ¿El endpoint `run-zk` debería vivir en `demo.ts` (como aquí, mismo patrón que `run`) o separado
   en `routes/zk.ts`/`routes/credentials.ts` para no mezclar "demo scaffolding" con las rutas reales?
2. ¿Vale la pena, en vez de un fixture fijo (WP-D1), dejar el botón de "Comprar" y "Gastar" como dos
   pasos manuales separados en la UI (el usuario pega un proof) en vez de un solo click automático?
   Es más honesto sobre el paso manual de `nargo`/`bb`, pero rompe el ritmo "wow" de un solo click.
3. ¿Grabamos una segunda toma corta con Base si el fondeo llega a tiempo, o mantenemos el submission
   100% Stellar para no complicar la edición?

---

**No se ha tocado código todavía.** Este plan se entrega a Fable para revisión antes de construir
WP-D1–WP-D4, mismo patrón que `BASE_IMPLEMENTATION_PLAN_2026-07.md`.
