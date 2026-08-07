# MicoPay Bridge

Puente XRPL↔Stellar para atomic swaps HTLC, y el stack de agentes que lo usa.

Repo hermano de [`micopay-protocol`](https://github.com/ericmt-98/micopay-protocol), del que
salió por el split de agosto 2026. **Aquí no vive nada del APK ni de la app móvil.**

## Qué hay hoy

| Ruta | Qué es | Estado |
|---|---|---|
| `packages/xrpl-bridge/` | Pierna XRPL: traducción cripto/tiempo, relay de dos ledgers, suite de fallos y agentes de demo | ✅ verificado contra testnets reales — [README](packages/xrpl-bridge/README.md) |
| `packages/types/` | Tipos compartidos | migrado |
| `packages/sdk/` | `AtomicSwapClient` (`lock/release/refund/getStatus`) | migrado |
| `apps/agent/` | AIGENTS: intent parser, executor, tools | migrado |
| `apps/api/` | API de protocolo x402 | migrado **filtrado** — ver abajo |
| `apps/web/` | Consola de demos del agente (sin login: es un observador humano, no algo que un agente vea) | migrado **filtrado** — ver abajo |
| `contracts/htlc-core/` | Primitivas HTLC compartidas (`MIN_TIMEOUT_LEDGERS`, TTL) | migrado tal cual |
| `contracts/atomic-swap/` | `AtomicSwapHTLC` — el contrato que la pierna XRPL espeja | migrado tal cual |
| `contracts/micopay-escrow/` | Escrow del **servicio x402** | migrado tal cual |
| `contracts/zk-verifier/` | `ZkVerifierRegistry` | migrado tal cual |
| `circuits/` | Noir: `access_credential_v1`, `poseidon_preimage`, `reputation_v1` | migrado tal cual |

### Qué se quedó fuera de `apps/api`

Rutas retail cuya versión viva es `micopay/backend`: `auth`, `users`, `cash`, `fund`,
`cetes`, `blend`, `kyc`, `ramp`, `merchants`, `trade-messages`, `trades`, `stellar`.
Con ellas se fueron sus servicios (`etherfuse`, `merchant`, `p2p`, `p2p-registry`,
`secret`, `trade`), `db/auth.ts`, `middleware/auth.middleware.ts`, `lib/webhook-auth.ts`,
`lib/trade-auth.ts`, sus tests y la migración `002_etherfuse_ramp.sql`.

`routes/agent.ts` y `routes/swaps.ts` se migran pero **no están registrados** en
`index.ts` — tampoco lo estaban en el origen. Cablearlos es una decisión de producto,
no de migración.

### Qué se quedó fuera de `apps/web`

`App.tsx` no tiene router: monta seis pestañas y nada más. Todo `src/pages/` era
**inalcanzable** — doce pantallas retail duplicadas de `micopay/frontend`, más
`BottomNav`, `Logo`, `MapSim`, `MerchantCard`, `Skeleton`, `services/api.ts` y las
imágenes de `public/` que solo usaba el mapa. Nada de eso se migró.

`SwapStatus.tsx` sí se migra aunque hoy no lo importa nadie: el §M5 del plan lo nombra
como material del demo, y es donde entrará la pierna XRPL cuando sustituya a
`ATOMIC_SWAP_CONTRACT_B`.

## Qué falta migrar

Solo `contracts/micopay-badges`, y está **sin decidir**: el plan lo deja abierto en §2.3
y no aparece referenciado ni en `render.yaml` ni en `.env.example`.

## La frontera entre los dos repos

| | `micopaybridge` (aquí) | `micopay-protocol` |
|---|---|---|
| Producto | Agentes, x402, ZK, puente cross-chain | APK + app móvil retail |
| Backend | `apps/api` (protocolo x402) — pendiente de migrar | `micopay/backend` — en producción |
| Escrow Soroban | `micopay-escrow` del servicio x402 — pendiente | `micopay/contracts/escrow` (móvil), `CB4M5777…ALO3HZ` |
| Se despliega | no todavía | sí |

**Sin resolver:** `apps/api/src/routes/reputation.ts` sirve tiers a agentes pero los calcula
leyendo datos de comercios, que tras el split son del backend móvil. Hay que decidir la
frontera antes de migrar esa ruta (§M3 del plan). Mientras tanto no se migra.

## Origen del código migrado

Copia plana desde `micopay-protocol` en `0b81a78`. No se trajo historia: para rastrear un
archivo hay que buscarlo en el repo de origen a esa altura.

## Desarrollo

```bash
npm install          # workspaces npm + turbo
npm run typecheck    # gate 1
npm test             # gate 2 — tests offline de todos los workspaces
```

```bash
cd contracts && cargo test --workspace
```

Los tres corren en CI y son bloqueantes. La suite contra testnets reales
(`npm run test:live -w @micopaybridge/xrpl-bridge`) **no** va en CI: necesita identidades
de Stellar fondeadas y tarda ~5 min.

## Licencia

MIT © Micopay.
