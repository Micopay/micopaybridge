# Auditoría — ZK Agent Credentials

> **Fecha:** 2026-06-27 · **Auditor:** revisión de código vs documentación.
> **Alcance:** ¿la solución documentada (credenciales anónimas para consumir recursos)
> coincide con lo que está realmente implementado y desplegado?
> **Método:** lectura directa de `contracts/zk-verifier/src/lib.rs`,
> `apps/api/src/routes/zk.ts`, `circuits/reputation_v1/src/main.nr`,
> `apps/api/src/middleware/x402.ts` y los artefactos de demo.

---

> ## ✅ Actualización 2026-06-27 — hallazgos #1 y #2 RESUELTOS
> - **#2** Se creó el circuito **`access_credential_v1`** (burn-once: `leaf=H(secret,0)`,
>   `nullifier=H(secret,1)` con dominio fijo). 5/5 tests nargo.
> - **#1** El nullifier ahora es **determinista por credencial** (el prover no puede rotar el
>   dominio). `verify_unique` se generalizó a leer el nullifier como los últimos 32 bytes
>   (compatible con `reputation_v1`). 7/7 tests del contrato.
> - **Redesplegado** en testnet: `CBOWU3OVOPGN3ME2R7EFK2Z2JZY4XYRB6A3HBTQ2Q2WWPSXK3VREUQC7`
>   (admin = `deployer`), ambos circuitos registrados.
> - **E2E verificado on-chain:** proof real de `access_credential_v1` → `verify_unique` OK;
>   segundo envío del mismo proof → `NullifierAlreadyUsed (#10)`. **Burn-once demostrado.**
> - **§3 RESUELTO (2026-06-28):** `POST /api/v1/inference` gateado por credencial ZK, probado
>   e2e en testnet — credencial válida → `verify_unique` quema el nullifier → Claude responde
>   (`credential_spent: true`); reusarla → 409; proof inválido → 400/403. El consumo del recurso
>   ya está cableado (la credencial es el "ticket" prepagado; x402 vive en la etapa de compra).
> - **Etapa de compra x402 RESUELTA (2026-06-28):** `POST /api/v1/credentials/buy` (x402) →
>   emite credencial + publica su raíz. Tubería completa de 3 piezas probada e2e: comprar (x402)
>   → gastar (credencial+ZK) → Claude responde; pago público, gasto anónimo y no-ligable.
>   Caveat demo: credencial server-minted (producción = commitment del cliente); contrato de raíz
>   única → una credencial activa a la vez.
> - **Pendientes aún abiertos:** §2.4 (medición de saldo / "cuánto le queda"), árbol multi-usuario
>   para anonimato creíble (hoy 1 hoja por raíz), commitment generado por el cliente (no-ligabilidad
>   total frente al emisor), §4 (Base/Solana).

---

## Veredicto en una línea

El **motor criptográfico es real, está desplegado y respalda la promesa central** (verificación
ZK anónima + anti-doble-gasto on-chain). Pero la **narrativa va por delante del código** en tres
puntos concretos: (1) el circuito "credencial de acceso" no existe como tal, (2) la semántica del
nullifier es de *reputación*, no de *ficha de un solo uso*, y (3) "consumir el recurso" y la
adquisición desde Base/Solana no están construidos. Nada de esto es bloqueante para el relato del
hackathon Stellar-only, pero sí hay que decirlo con honestidad.

---

## 1. Qué está realmente construido y desplegado ✅

| Componente | Evidencia en código | Estado |
|---|---|---|
| Contrato `ZkVerifierRegistry` | `contracts/zk-verifier/src/lib.rs` | ✅ Desplegado testnet `CBOWU3OV…EUQC7` |
| Verificación UltraHonk/BN254 en Soroban | `verify()` L87-101 vía `ultrahonk_soroban_verifier` | ✅ Verificada on-chain (tx `330be3e4…`) |
| Anti-doble-gasto (nullifier on-chain) | `verify_unique()` L109-148 | ✅ Implementado |
| Registro de VKs admin-only | `register_circuit()` L45-63 + `require_admin()` | ✅ |
| Raíz Merkle on-chain | `set/get_reputation_root()` L66-78 | ✅ |
| Endpoint pago-por-uso x402 | `apps/api/src/routes/zk.ts` L114-116 (0.001 USDC) | ✅ |
| Ruteo `reputation_v1`→`verify_unique`, 409 en replay | `zk.ts` L51, L191-195 | ✅ |
| Validación de forma (shape) de public_inputs | `zk.ts` L129-153 | ✅ |
| Cross-check de la raíz on-chain | `zk.ts` L165-178 | ✅ |
| Circuito `reputation_v1` (Merkle+threshold+nullifier) | `circuits/reputation_v1/src/main.nr` | ✅ |
| Tests | `contracts/zk-verifier/src/test.rs` (6), `apps/api/src/__tests__/zk.test.ts` | ✅ Existen |
| Demos | `apps/api/demo/run_demo_a.sh`, `run_demo_b.sh`, `prove.html` | ✅ Existen |

**Conclusión:** el "motor" (pertenencia Merkle anónima + nullifier + verificación BN254 en Soroban)
es genuino y está operativo. La afirmación del one-pager *"la máquina de verificación está viva"* es
correcta.

---

## 2. El gap central: narrativa de "credencial" vs código de "reputación" ⚠️

### 2.1 No existe `access_credential_v1`
La documentación (`HACKATHON.md`, `SPEC.md`) presenta como **flagship** una *credencial de acceso*
cuya hoja significa "credencial pagada". En el repo solo hay dos circuitos: `poseidon_preimage` y
`reputation_v1`. **No existe `circuits/access_credential_v1/`.**

- Hoy: hoja = `pedersen_hash([secret, tier])` + chequeo `tier >= tier_threshold`.
- Credencial de acceso "pura": no necesita `tier`/`threshold`; la hoja sería `H(secret)` (o
  `H(secret, cuota)`), y la prueba sería solo "conozco una hoja del árbol + nullifier".

El propio doc lo admite ("mismo primitivo, construido sobre un motor probado"), pero **el lector
puede creer que la credencial de acceso ya está desplegada cuando lo que corre es reputación.**

### 2.2 El nullifier está ligado al `context`, no a la credencial — ESTE es el hallazgo importante
En el circuito: `nullifier = pedersen_hash([secret, context])` (`main.nr` L45).
El `context = H(verifier_id, session)`. Esto es **correcto para reputación** (evita que una prueba
hecha para el verificador B se reuse con el verificador C). **Pero rompe la garantía de "ficha de un
solo uso" que vende el one-pager.**

- El one-pager dice: *"Reuse: same nullifier → rejected (double-spend prevented)"*.
- Eso solo se cumple **si el `context` es fijo**. Como el `context` cambia por sesión/verificador,
  la **misma credencial (mismo `secret`) produce un nullifier distinto en cada contexto** → se puede
  volver a gastar en una sesión nueva.
- **Implicación directa para tu objetivo ("garantizar que no haya consumos excesivos / spam"):**
  con la semántica actual, un agente podría reusar la misma credencial cambiando de contexto. El
  límite real de consumo NO está garantizado todavía.

**Arreglo:** para una credencial de acceso de un solo uso global, el nullifier debe depender solo de
la credencial, p.ej. `nullifier = H(secret)` (o `H(secret, leaf)`), independiente del `context`. El
`context` puede seguir existiendo como binding anti-MITM, pero el **gasto** debe contarse por
credencial. Esto es un cambio de ~5 líneas en el circuito + re-generar VK + re-registrar.

### 2.3 Nombres "reputation" filtrados en el contrato
`set_reputation_root` / `get_reputation_root` / `REP_ROOT` asumen una sola raíz "de reputación".
Para credenciales de acceso conviene una raíz de credenciales (o un set de raíces por emisor). No es
bloqueante, pero el naming refuerza la confusión narrativa↔código.

### 2.4 Falta el "—y cuánto le queda—" (medición de saldo)
La propuesta de valor (ver [`VALUE_PROP.md`](./VALUE_PROP.md)) promete probar **cuánto saldo le
queda** a una credencial. El circuito actual **no mide saldo**: hace un chequeo de umbral
(`tier >= tier_threshold`) sobre un valor estático en la hoja, y no hay mecanismo de
decremento/actualización. Hay dos arquitecturas y conviene elegir a conciencia:

- **Fichas discretas** (casi implementado): N credenciales de un solo uso; "cuánto le queda" = cuántas
  no ha gastado, contadas **por el cliente** (la no-ligabilidad impide que el emisor las cuente).
- **Credencial con saldo** (no implementado): balance + *range proof* ("saldo ≥ X") + actualización.
  Es un circuito nuevo, más complejo que `reputation_v1`.

**Implicación:** la frase de valor es literal solo con la opción 2. Con la opción 1 (la actual), "cuánto
le queda" es un conteo del lado cliente, no una prueba on-chain. No es bloqueante para el hackathon,
pero define qué tan honesta es la promesa.

---

## 3. "Consumir el recurso" no está cableado ⚠️

El endpoint `/api/v1/zk/verify` devuelve `{ verified, circuit_id, payer }` (`zk.ts` L183-187).
**Verifica la credencial, pero no sirve ningún recurso después.** El caso de uso estrella —
"el agente prueba credencial → recibe inferencia de Claude/Anthropic" — no existe en código: no hay
proxy a un proveedor de inferencia ni un endpoint de recurso protegido por la credencial.

Hoy la demo prueba: *"se gastó una credencial válida"*. Falta: *"…y por eso te entrego el recurso X"*.
Para tu visión (consumir inferencia) hace falta un endpoint tipo `POST /api/v1/inference` que:
exige prueba de credencial válida (vía la ruta ZK / `verify_unique`) → si pasa, reenvía el prompt al
proveedor → devuelve la respuesta. Eso es lo que convierte "verificación" en "acceso a recurso".

---

## 4. La conexión a Base / mercados agénticos: 0% construido ⛔

`apps/api/src/middleware/x402.ts` solo maneja pago Stellar (XDR) + `mock:` (L107-115).
**No hay EIP-3009, ni Base, ni Solana, ni CCTP.** Todo `BASE_BRIDGE_PLAN.md` (WP1-WP9) es diseño
post-hackathon, y el propio plan lo declara explícitamente ("Stellar-only demo"). Es coherente, pero
hay que tenerlo claro: **"conectarnos a los mercados agénticos de Base" es aspiración documentada, no
implementación.** La distribución real (listar en agentic.market) tampoco está hecha.

---

## 5. Privacidad: honesta, pero ojo con la demo ⚠️

- El doc es **honesto** sobre lo que ZK oculta (identidad, ligabilidad) y lo que NO (el contenido del
  prompt). Bien — no sobrevende.
- **Pero la fuerza de la privacidad = tamaño del conjunto de anonimato = tamaño del árbol.** La demo
  usa un árbol de **un solo usuario (alice)** → conjunto de anonimato = 1 → **anonimato nulo en la
  demo**. El one-pager menciona "más credenciales = más privacidad", pero la demo concreta no tiene
  anonimato real. Para una demo creíble conviene un árbol con N≥varias hojas.

---

## 6. Otros puntos menores

- **Costo por consumo:** `verify_unique` hace una **transacción on-chain con escritura persistente**
  (el nullifier) por cada verificación, firmada por `ADMIN_SECRET_KEY`, fee hasta 0.1 XLM (`zk.ts`
  L59). A escala, cada "consumo" es un write on-chain — barato pero no gratis; modelarlo.
- **El servidor verifica con la admin key**, no el agente. Correcto para "el agente no necesita cuenta
  Stellar", pero significa que MicoPay paga el gas de cada verificación (a cubrir con el fee x402).
- **Hash Pedersen, no Poseidon:** ya documentado honestamente (nargo 1.0.0-beta.9 no exporta
  poseidon). Sin problema, pero un juez técnico lo notará — está bien que esté explicado.
- **Poll con `setTimeout` de 2s × 30** (`zk.ts` L79-93): latencia de hasta ~60s por verificación.
  Aceptable para demo, revisar para producción.

---

## 7. Recomendaciones priorizadas

| # | Acción | Esfuerzo | Por qué |
|---|---|---|---|
| 1 | **Decidir y arreglar la semántica del nullifier** (`H(secret)` para un solo uso global) | ~½ día (circuito+VK+redeploy) | Sin esto, la garantía anti-sobreconsumo/spam **no se cumple**. Es el corazón de tu idea. |
| 2 | **Crear `access_credential_v1`** (hoja = credencial, sin tier) o renombrar y documentar que reputación = aplicación | ~1 día | Alinea flagship narrativo con código; quita la confusión. |
| 3 | **Cablear un recurso real** (`/api/v1/inference` gated por credencial → proxy a Claude) | ~1-2 días | Convierte "verifico" en "consumo un recurso" — la historia completa. |
| 4 | **Árbol de demo con N usuarios** | ~2 h | Para que el anonimato de la demo sea creíble (hoy es 1). |
| 5 | **Modelar adquisición de credenciales** (pago x402 → emite N fichas → N hojas) | diseño + ~1 día | Hoy la "compra" de credenciales es conceptual; falta el flujo emisor. |
| 6 | **Decidir arquitectura de medición** (fichas discretas vs credencial con saldo) | decisión + ½–2 días | Define si "—y cuánto le queda—" es literal (§2.4). Fichas para hackathon; saldo para producto. |
| 7 | Base/Solana (BASE_BRIDGE_PLAN) | semanas | Solo si el alcance pasa de hackathon Stellar a producto. Explícitamente post-hackathon. |

---

## 8. Qué pienso (resumen ejecutivo)

La base es **sólida y poco común**: tienes verificación ZK real sobre Soroban con anti-doble-gasto
on-chain, desplegada y probada. Eso ya es un activo diferenciador para un hackathon de Stellar.

**El upside estratégico es de plataforma, no de app** (ver [`VALUE_PROP.md`](./VALUE_PROP.md)): el
mismo motor —pertenencia + umbral + nullifier— sirve a muchos negocios cambiando solo el significado
de la hoja (inferencia, compliance/KYC, data, ticketing, anti-sybil). Eso es justo la tesis del
`ZkVerifierRegistry`. Pero ese upside **solo es creíble si el caso base funciona de punta a punta** —
y ahí están los gaps de abajo.

El riesgo no es técnico de fondo, es de **coherencia y de "última milla del relato"**:

1. **El gap más serio es el nullifier ligado a `context`** (§2.2). Hoy la frase "garantizamos que no
   haya consumo excesivo" **no es cierta** con contextos rotativos. Es un arreglo pequeño pero
   imprescindible si ese es el corazón del pitch.
2. **Falta "consumir el recurso" de verdad** (§3). Verificar una credencial es el 80%; el 20% que
   convence (servir inferencia tras verificar) no está. Sin eso, la demo prueba un primitivo, no un
   producto.
3. **Lo de Base es aspiración** (§4). Perfecto como roadmap; peligroso si se presenta como hecho.

Mi recomendación: para el hackathon, **quédate Stellar-only** (como ya dice el plan), arregla el
nullifier (#1), cablea un recurso mínimo real (#3) y haz un árbol de demo con varios usuarios (#4).
Eso te da una historia verdadera y completa — "un agente consume un recurso con una credencial
anónima de un solo uso, verificada en Soroban" — sin prometer nada que el código no haga. Base/Solana
y pesos quedan como el roadmap creíble que ya está escrito.
