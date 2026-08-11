# ZK Agent Credentials — Private Resource Access for AI Agents

> **Carpeta canónica de la iniciativa "credenciales ZK para consumir recursos".**
> Aquí vive todo lo relacionado con el reencuadre de ZKaaS hacia *credenciales de
> acceso anónimas* que permiten a un agente consumir un recurso (inferencia, datos,
> APIs) sin revelar su identidad ni permitir ligar su actividad — verificado en
> Stellar (Soroban).

---

## La idea en una frase

> **Un agente consume un recurso probando que tiene una credencial de acceso válida y
> sin gastar — anónima, no-ligable y de un solo uso (anti-spam / anti-sobreconsumo) —
> verificada con zero-knowledge en Soroban.**

El mecanismo es una **credencial anónima tipo "ficha de arcade"**: comprar = una hoja
`H(secreto)` en un árbol Merkle cuya raíz se publica en Soroban; consumir = una prueba
ZK de pertenencia + revelar un `nullifier`; reusar = el mismo `nullifier` se rechaza
on-chain (doble-gasto bloqueado). Eso último es el control que evita el consumo excesivo.

---

## Qué hay en esta carpeta

| Archivo | Qué es | Estado |
|---|---|---|
| [`STATUS.md`](./STATUS.md) | **Empieza aquí.** Dónde estamos, qué está probado, qué falta, cómo correr el demo. | Vivo |
| [`HACKATHON.md`](./HACKATHON.md) | One-pager para el hackathon ZK. La idea en 2 minutos. | Listo |
| [`PITCH_ES.md`](./PITCH_ES.md) | La historia en español llano (para presentar) + nota de custodia. | Listo |
| [`VALUE_PROP.md`](./VALUE_PROP.md) | Propuesta de valor: por qué escala a muchos negocios + verticales. | Listo |
| [`SPEC.md`](./SPEC.md) | Spec técnico completo (arquitectura, circuitos, contrato, demos, despliegue). | Listo (framing credencial) |
| [`BASE_BRIDGE_PLAN.md`](./BASE_BRIDGE_PLAN.md) | Estrategia/"por qué" del puente a **Base + Solana** (x402 + CCTP → Stellar). | **Roadmap** |
| [`BASE_IMPLEMENTATION_PLAN.md`](./BASE_IMPLEMENTATION_PLAN.md) | El **cómo** construir el lado Base desde hoy (WP1-WP6, archivos concretos). | **Roadmap, no construido** |
| [`AUDIT.md`](./AUDIT.md) | Auditoría honesta: qué está construido, qué no, y el gap narrativa↔código. | Listo |

---

## Estado en una mirada (resumen — el detalle está en `AUDIT.md`)

- ✅ **Motor desplegado en testnet:** contrato `ZkVerifierRegistry`
  (`CBOWU3OVOPGN3ME2R7EFK2Z2JZY4XYRB6A3HBTQ2Q2WWPSXK3VREUQC7`), verificación UltraHonk/BN254
  en Soroban, demo verificada on-chain.
- ✅ **Anti-doble-gasto on-chain:** `verify_unique` registra el `nullifier` y rechaza repeticiones (409).
- ✅ **Pago por uso:** endpoint `/api/v1/zk/verify` detrás de x402 (0.001 USDC).
- ✅ **`access_credential_v1` desplegado y verificado on-chain (2026-06-27):** nuevo circuito
  burn-once (`leaf=H(secret,0)`, `nullifier=H(secret,1)` con dominio fijo). Proof real verificado
  en Soroban; un segundo intento del mismo proof se rechaza con `NullifierAlreadyUsed (#10)` →
  **burn-once demostrado** (resuelve los hallazgos #1 y #2 del audit).
- ✅ **Nullifier determinista por credencial:** el dominio es una constante del circuito que el
  prover no puede rotar → cada credencial se gasta exactamente una vez. `verify_unique` lee el
  nullifier como los últimos 32 bytes (compatible con `reputation_v1`).
- ✅ **Tubería completa de 3 piezas probada e2e (2026-06-28):**
  - **Comprar (x402):** `POST /api/v1/credentials/buy` — pagas USDC → recibes una credencial y su
    raíz se activa on-chain. Pago **público**.
  - **Gastar (credencial + ZK):** `POST /api/v1/inference` — presentas la prueba → se quema el
    nullifier on-chain → **Claude responde** (`credential_spent: true`). Gasto **anónimo y
    no-ligable** a la compra.
  - Probado en vivo: comprar (x402 mock) → credencial 4001 → proof → Claude responde; reusar → 409;
    proof inválido → 400/403. (Resuelve audit §3 y la etapa de compra.)
- ⛔ **Base/Solana: 0% construido.** El x402 actual solo entiende Stellar+mock. `BASE_BRIDGE_PLAN.md`
  es diseño post-hackathon.

---

## Procedencia (de dónde salió esto)

- Conversación de diseño del **2026-06-16** (memoria `project_base_agent_marketplace_strategy`).
- Reencuadre documental en la rama `docs/private-access-reframe` (commits `f2cfbee`, `7718411`),
  **consolidado aquí** el 2026-06-27.
- El código del reencuadre (`verify_unique`, ruteo `reputation_v1`→`verify_unique`) ya está
  mergeado en `main`/`feat/wave6` (`337d705`, `0baa136`, `3c7c72d`).

> El antiguo `docs/ZK-as-a-Service/` queda como histórico (framing previo de "reputación
> pública vs privada"). Esta carpeta es la fuente de verdad de la iniciativa de credenciales.
