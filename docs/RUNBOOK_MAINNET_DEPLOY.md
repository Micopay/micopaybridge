# Runbook — deploy a mainnet (MicoPay Bridge)

No ejecutar nada de esto sin luz verde del team. Preparado para que, cuando
la den, sea copiar-pegar y no perder tiempo decidiendo comandos.

Los pasos que mueven fondos reales (deploy con XLM real, fondeo de wallets
XRPL) los corre **Raúl**, no un agente — son transferencias irreversibles.

## 0. Antes de arrancar

- [ ] Team confirmó cuenta/proyecto Render para `micopaybridge-api`
- [ ] Team confirmó que `apps/api` de este repo va a mainnet para el reto
- [ ] Reconfirmado en el Hacker Dashboard: fecha límite del Mainnet Gate y
      que el source tag sigue siendo `2607170001`
- [ ] Identidad Stellar CLI para el deploy, fondeada en mainnet con XLM real
      (no la testnet `raul-bridge`/`mota-agent` — esas no sirven aquí)

## 1. Contrato Soroban — `atomic-swap` (AtomicSwapHTLC)

Workspace mezcla dos majors de `soroban-sdk` (`Cargo.toml` raíz de
`contracts/`, comentario en el bloque `[workspace]`). `atomic-swap` y su
dependencia `htlc-core` van en `soroban-sdk 21.7.6` → target
`wasm32-unknown-unknown`. No usar `wasm32v1-none` (ese es para
`zk-verifier`, que no hace falta para el puente).

```bash
cd "contracts"

# build — target correcto para este contrato, no el del workspace completo
stellar contract build --package atomic-swap

# el wasm optimizado queda en:
#   target/wasm32-unknown-unknown/release/atomic_swap.wasm

# deploy a mainnet — pide confirmación, cuesta XLM real
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/atomic_swap.wasm \
  --source <IDENTIDAD_MAINNET_FONDEADA> \
  --network mainnet
```

`atomic-swap/src/lib.rs` no tiene `initialize`/constructor — no hace falta
pasar argumentos de instancia al deploy. El contrato queda listo para
recibir `lock()` directo.

El comando imprime el `Contract ID` nuevo (empieza con `C...`). Copiarlo a:

- `render.yaml` → `ESCROW_CONTRACT_ID` y `ATOMIC_SWAP_CONTRACT_A` (los dos
  TODO marcados)
- Dashboard de Render, si se prefiere no versionarlo ni siquiera como TODO

No hace falta desplegar `ZK-verifier` ni `micopay-escrow` para el puente —
son de otras piezas del monorepo, no de M4.5.

## 2. Pierna XRPL — sin contrato, solo cuentas fondeadas

XRPL no tiene contrato que desplegar: `EscrowCreate`/`EscrowFinish` son
primitivas nativas del ledger. Lo único que hace falta:

- [ ] Dos wallets XRPL mainnet fondeadas con XRP real (reserva de cuenta +
      lo que se vaya a mover) — las que hoy son demo en testnet
      (`XRPL_COUNTERPARTY_SEED`, `XRPL_INITIATOR_SEED` en `.env`)
- [ ] Verificar que las claves no se pegan en ningún archivo versionado —
      van directo al dashboard de Render como secret (`sync: false`, ya en
      `render.yaml`)

**Ya verificado, no tocar:** `apps/api/src/lib/xrpl-leg.ts:70,107,133`
mete `SourceTag: bt.SOURCE_TAG` en las tres transacciones (`EscrowCreate`,
`EscrowFinish`, `EscrowCancel`), y `bridge-translate.js:33` fija
`SOURCE_TAG = 2607170001` — coincide con el source tag del Hacker
Dashboard. El etiquetado ya está bien cableado; el riesgo no está ahí.

## 3. Variables de red — completar en `render.yaml`

Los dos `# VERIFICAR antes de desplegar` del archivo:

- `STELLAR_RPC_URL` — `https://mainnet.sorobanrpc.com` es el endpoint
  público estándar; confirmar que sigue vivo antes del deploy
- `XRPL_SERVER` — `wss://xrplcluster.com` es el cluster público estándar;
  alternativa: `wss://s2.ripple.com` (full history)
- `USDC_ISSUER` — **no completar de memoria**. Si el swap mueve USDC en la
  pierna Stellar, el emisor mainnet correcto se confirma en
  https://stellar.expert o con el propio Circle, nunca a ojo — un emisor
  equivocado manda fondos a la dirección que no es.

## 4. Smoke test — un swap real, antes de abrir a usuarios

No saltarse este paso. Antes de anunciar nada:

```bash
npm run test:live -w @micopay/api
```

Con las envs de mainnet cargadas, no las de testnet. Confirmar en un
explorer real (stellar.expert, livenet.xrpl.org) que las dos piernas
cerraron y que la tx de XRPL trae el source tag `2607170001` visible.

## 5. Lo que este runbook NO resuelve

Desplegar esto no genera las 300 cuentas distintas que pide el reto — eso
sigue abierto, ver conversación sobre replantear la estrategia (T&C solo
exige 1 tx firmada por dirección, no un swap atómico completo). Este
runbook solo deja la infraestructura lista para que, decidida la
estrategia, no haya que perder tiempo en comandos.
