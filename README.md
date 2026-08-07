# MicoPay Bridge

Puente XRPL↔Stellar para atomic swaps HTLC, y el stack de agentes que lo usa.

Repo hermano de [`micopay-protocol`](https://github.com/ericmt-98/micopay-protocol), del que
salió por el split de agosto 2026. **Aquí no vive nada del APK ni de la app móvil.**

## Qué hay hoy

| Ruta | Qué es | Estado |
|---|---|---|
| `packages/xrpl-bridge/` | Pierna XRPL: traducción cripto/tiempo, relay de dos ledgers, suite de fallos y agentes de demo | ✅ verificado contra testnets reales — [README](packages/xrpl-bridge/README.md) |
| `contracts/htlc-core/` | Primitivas HTLC compartidas (`MIN_TIMEOUT_LEDGERS`, TTL) | migrado tal cual |
| `contracts/atomic-swap/` | `AtomicSwapHTLC` — el contrato que la pierna XRPL espeja | migrado tal cual |

## Qué falta migrar

Del inventario del plan de split, siguen en `micopay-protocol`: `apps/api` (filtrado),
`apps/agent`, `apps/web` (filtrado), `packages/sdk`, `packages/types`, `circuits/`,
`contracts/zk-verifier`, `contracts/micopay-badges` y `contracts/micopay-escrow` — este
último el del **servicio x402**, no el del móvil. Son dos contratos distintos que
divergieron en abril y no se deben mezclar.

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
