# STATUS — ZK Agent Credentials

> **Dónde estamos y qué falta, en un solo lugar.** Actualizar al final de cada sesión.
> Última actualización: **2026-06-28**. Rama: **`feat/zk-agent-credentials`** (sobre `origin/main`).

---

## Resumen en una línea

> **La tubería completa funciona end-to-end en testnet:** pagas con x402 → recibes una credencial
> anónima → la gastas con una prueba ZK → Claude responde, y la credencial no se puede reusar.
> Pago público, consumo anónimo y no-ligable. Es una demo real, no un negocio probado.

---

## La tubería (las 3 piezas, ninguna sustituye a otra)

```
COMPRAR  →  POST /api/v1/credentials/buy   (x402, pago PÚBLICO)
            → emite credencial + activa su raíz Merkle on-chain
                        │
GASTAR   →  POST /api/v1/inference          (credencial + ZK, gasto ANÓNIMO)
            → verify_unique quema el nullifier on-chain → Claude responde
```

x402 = el pago · credencial = el ticket · ZK = lo que hace el gasto anónimo y no-ligable a la compra.

---

## Construido y VERIFICADO ✅

| Componente | Estado | Evidencia |
|---|---|---|
| Circuito `access_credential_v1` (burn-once) | ✅ | `nargo test` 5/5; VK keccak 1760B |
| `verify_unique` (nullifier = últimos 32 bytes) | ✅ | `cargo test -p zk-verifier` 7/7 |
| Contrato desplegado + 2 circuitos registrados | ✅ | testnet `CBOWU3OVOPGN3ME2R7EFK2Z2JZY4XYRB6A3HBTQ2Q2WWPSXK3VREUQC7` |
| Burn-once on-chain | ✅ | spend OK → re-spend `NullifierAlreadyUsed (#10)` |
| `POST /api/v1/inference` (gasto + Claude) | ✅ | e2e: credencial → Claude responde; reuse → 409; inválido → 400/403 |
| `POST /api/v1/credentials/buy` (x402) | ✅ | e2e: x402 mock → credencial 4001 + raíz activada |
| Tubería completa e2e (comprar → gastar) | ✅ | comprar 4001 → proof → inference → Claude responde |

**Hechos clave**
- Contrato `ZkVerifierRegistry`: `CCZHC456HBJRTZP45V5AT3ILHP3MOVH36MHR7HUWQHV2JLN6MJEITXB2` (redeployado
  2026-07-02 tras la Fase 0 — el WASM anterior en `CBOWU3OVOPGN3ME2R7EFK2Z2JZY4XYRB6A3HBTQ2Q2WWPSXK3VREUQC7`
  quedó obsoleto, no lo uses). Admin = misma identidad stellar-cli `deployer`.
- Circuitos registrados: `poseidon_preimage`, `reputation_v1` (4 inputs), `access_credential_v1`
  (2 inputs: `[merkle_root, nullifier]`) — las tres VKs, `deploy-zk.ts` tenía a `access_credential_v1`
  faltante en `register` y se corrigió en este redeploy.
- Raíz del pool demo (`credential_pool.json`, 4 credenciales) republicada: `0x14c2e3a5cbe2cd94f080c87e3344d0d03f94f71507d3617b3a17e9b333a821f7`.
- Endpoints nuevos: `apps/api/src/routes/credentials.ts` (buy), `routes/inference.ts` (spend), helper `lib/zkVerify.ts`.
- Pool demo: `apps/api/demo/credential_pool.json` (secrets 4001-4004).

---

## Cómo correr el demo

```bash
# 1. Infra
docker compose up -d postgres
cd apps/api && npm run dev          # http://localhost:3000  (necesita .env: ANTHROPIC_API_KEY,
                                    # ADMIN_SECRET_KEY, ZK_VERIFIER_CONTRACT_ID, SOROBAN_RPC_URL,
                                    # DATABASE_URL, SEED_DEMO_DATA=false)

# 2. COMPRAR (x402 mock) -> devuelve { credential.secret, public_inputs } y activa la raíz
curl -s -X POST localhost:3000/api/v1/credentials/buy \
  -H 'Content-Type: application/json' -H 'X-Payment: mock:GBUYER:0.01' -d '{}'

# 3. Generar el proof de esa credencial (WSL2; secret del paso 2 en Prover.toml)
#    cd circuits/access_credential_v1 && nargo execute witness
#    bb prove --scheme ultra_honk --oracle_hash keccak -b target/access_credential_v1.json \
#       -w target/witness.gz -o pd     (proof PLANO, sin bytes_and_fields)

# 4. GASTAR -> Claude responde
curl -s -X POST localhost:3000/api/v1/inference -H 'Content-Type: application/json' \
  -d '{"proof":"<base64>","public_inputs":["<root_dec>","<nullifier_dec>"],"prompt":"..."}'
```

---

## Qué FALTA (priorizado)

| # | Pendiente | Por qué importa | Esfuerzo |
|---|---|---|---|
| ~~1~~ | ~~**Árbol multi-usuario**~~ ✅ **HECHO (2026-06-28)** | Pool de 4 credenciales bajo UNA raíz compartida, cada una con su ruta Merkle real; raíz publicada una sola vez → varias credenciales activas a la vez. Verificado e2e: 2 credenciales distintas del mismo árbol gastadas OK. Anonymity set = 4. | — |
| ~~2~~ | ~~**Commitment generado por el cliente**~~ ✅ **HECHO (2026-06-29)** | `/credentials/buy` modo `client_generated`: el cliente genera el secreto y envía SOLO `H(secret)`; el emisor nunca ve el secreto (`issuer_knows_secret:false`). Verificado e2e. Caveat: demo single-leaf (anonimato 1 para esa raíz); multi-user + client-gen = batch-anchor de commitments. | — |
| 3 | **Saldo privado** ("cuánto le queda", range proof) | La forma más pura de "probar una verdad numérica ocultando el número" | Alto (circuito nuevo) |
| 4 | **Set = pagos x402** (sin emisor de confianza) | "soy uno de los que pagaron" sin emisor → el escalón que impresiona | Alto |
| 5 | **Base/Solana** (`BASE_BRIDGE_PLAN.md`) | Llegar a los mercados agénticos | Semanas (post-hackathon) |

---

## Caveats honestos (no engañarnos)

- **Demo, no negocio probado.** Es activo de hackathon + infraestructura + posicionamiento.
- **Credencial server-minted** en el demo (ver pendiente #2 para la no-ligabilidad total frente al emisor).
- **Anonymity set = 4** (pool demo de 4 credenciales bajo una raíz). Producción: árbol grande.
- **Nit de timing:** el cross-check de raíz en el gasto puede ir ~segundos atrás de la primera
  compra (snapshot del RPC) → reintentar. Producción: esperar finalidad o reintentar.

---

## Trampas del toolchain (referencia rápida — ya resueltas)

- **`stellar` en WSL = el .exe de Windows** (symlink). Correr `stellar` desde Git Bash con rutas
  `/c/...`; `nargo`/`bb` sí son Linux (en WSL).
- **VK** necesita `--output_format bytes_and_fields` (1760B vía `--output_path`); el **PROOF NO**
  (plano `bb prove -o dir/` + `--oracle_hash keccak`), o falla `g1_msm` ("bn254 deserialize Fp").
- Noir solo permite **ASCII** en comentarios.

---

## Bitácora de decisiones (no re-litigar)

- **Las 3 piezas conviven** (x402 compra / credencial / ZK gasta); la credencial NO reemplaza x402.
- **ZK solo donde hay algo que ocultar:** el pago es público; el gasto es lo privado.
- **Hash Pedersen** (no Poseidon — no exportado en nargo 1.0.0-beta.9); el verificador on-chain es agnóstico al hash.
- Este trabajo vive en `feat/zk-agent-credentials`, **sin tocar Wave 6** (sus cambios V-15 están en un stash en `feat/wave6`).
