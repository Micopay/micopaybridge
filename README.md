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
| `docs/` | Especificaciones ZK, auditorías y planes | migrado tal cual — [leer con advertencia](docs/README.md) |

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

`docs/xrpl-hackathon/`, que el §2.1 también lista, **no existe** en el repo origen:
buscado en todas las ramas remotas y en la historia completa. Ver
[SUBMISSION_CORRECCIONES.md](docs/SUBMISSION_CORRECCIONES.md).

## La frontera entre los dos repos

| | `micopaybridge` (aquí) | `micopay-protocol` |
|---|---|---|
| Producto | Agentes, x402, ZK, puente cross-chain | APK + app móvil retail |
| Backend | `apps/api` — protocolo x402 | `micopay/backend` — en producción |
| Escrow Soroban | `contracts/micopay-escrow` — el del servicio x402 | `micopay/contracts/escrow` — el del móvil, `CB4M5777…ALO3HZ` |
| Se despliega | no todavía | sí |

Los dos escrows **divergieron en abril y no son intercambiables**. Difieren en 78 líneas.
Unificarlos sería un cambio de comportamiento en producción disfrazado de limpieza.

**Sin resolver — la frontera del §M3.** `apps/api/src/routes/reputation.ts` sirve tiers de
reputación a agentes detrás de x402, pero los calcula leyendo datos de comercios que tras
el split son del backend móvil. Se migró con un `TODO` visible en el import: hoy es la
opción (a), leer el mismo esquema. La recomendada es la (b) — que `micopay/backend` exponga
un endpoint interno de reputación y este repo lo consuma, con un contrato explícito y
versionable. Mientras siga así, **una migración del móvil puede romper a los agentes sin
avisar**.

## Origen del código migrado

Copia plana desde `micopay-protocol` en `0b81a78`. No se trajo historia: para rastrear un
archivo hay que buscarlo en el repo de origen a esa altura.

## El swap de dos piernas

`POST /api/v1/swaps/execute` corre el flujo completo. La pierna B **ya no es una segunda
instancia de Soroban**: es un escrow nativo de XRPL.

```
1. lock A   Soroban  AtomicSwapHTLC.lock(secret_hash)        timeout LARGO
2. lock B   XRPL     EscrowCreate(Condition, CancelAfter)    timeout CORTO
3. reveal   XRPL     EscrowFinish(Fulfillment) → preimagen pública en el ledger
4. release  Soroban  AtomicSwapHTLC.release(secret)
```

Una sola preimagen gobierna las dos piernas: el fingerprint de la `Condition` de XRPL **es**
el `secret_hash` que valida Soroban. Si se generaran por separado no habría swap atómico,
sino dos escrows sin relación.

**Antes de firmar nada se comprueban DOS cosas, no una.** La invariante
`iniciador > contraparte` sola no basta: con `counterparty_ledgers=1` pasa (1200 s > 5 s) y
la ventana de XRPL se cierra antes del `EscrowFinish`. Verificado contra testnet:
`tecNO_PERMISSION` y la pierna de Soroban bloqueada. Por eso hay también un **piso**
(`MIN_COUNTERPARTY_TIMEOUT_SEC`, 300 s) derivado del mismo mínimo que exige el contrato.

### Cuando algo sale mal

Un swap que falla con fondos ya bloqueados queda en `refund_pending`, no en `failed` —
`failed` suena a "no pasó nada" y ahí hay dinero parado.

```bash
GET  /api/v1/swaps/pending-refunds     # qué quedó colgado
POST /api/v1/swaps/:id/refund          # devolver las dos piernas
```

Los dos **sin x402**: cobrar por devolver fondos que se quedaron atrapados sería el
incentivo equivocado. El refund es idempotente y se reintenta: ninguna de las dos cadenas
permite reembolsar antes de su timeout, así que `pending` es lo normal al principio.

Probado recuperando un swap que se quedó colgado de verdad, no un caso inventado:

| Pierna | Cadena | Tx | Resultado |
|---|---|---|---|
| B | XRPL | `AA01EBDDB9B59A8E9E709A09BD81C3855A63E23E05486B40A85CB54B1E4E2D06` | `EscrowCancel`, XRP devuelto |
| A | Soroban | `06662012c9a94d663242bb783daf87eb0be5a7561849541e6580cb7b42a592ff` | `get_status` → `"Refunded"` |

El primer intento devolvió `pending`: faltaban 82 ledgers para el timeout y el contrato
rechaza el refund prematuro. El segundo, pasado el ledger 4021415, cerró la pierna que
faltaba y **saltó la de XRPL porque ya estaba resuelta** — eso es la idempotencia,
comprobada en vez de afirmada.

El estado vive en `swap-store.json`, con escritura atómica y carga al arrancar. No es una
base de datos: es el mínimo para que un reinicio no pierda de vista dinero bloqueado.
Antes era un `Map` en RAM, y el `owner`/`offer_sequence` del escrow —lo único con lo que se
puede cancelar— moría con el proceso.

### Si el proceso muere a mitad

Al arrancar, la API revisa **contra las cadenas** qué quedó abierto. La verdad está en el
ledger, no en el estado guardado, que puede haberse quedado corto justo por el crash.

**La preimagen no se persiste, y es a propósito.** Es lo único que separa un swap atómico
de un robo: si la contraparte la obtiene sin haber revelado en su pierna, cobra la del
iniciador y no entrega nada. Escribirla en disco sería cambiar atomicidad por comodidad.

Eso deja dos finales, y la diferencia es dónde murió:

- **Después de revelar** → la preimagen ya es pública en el `EscrowFinish`. Se saca del
  ledger y se cobra la pierna de Soroban. **El swap se completa.**
- **Antes de revelar** → el secreto se fue con el proceso. Único final correcto:
  reembolsar las dos piernas. Lo que aún no ha vencido queda en un reintento cada 5 min.

```bash
npm run test:recovery -w @micopay/api
```

Mata el proceso en el peor momento —justo tras el `EscrowFinish`, con el XRP ya cobrado y
el XLM sin cobrar—, **descarta la preimagen** y arranca de nuevo. Corrido contra testnets:

```
[recovery] 1 swap(s) a medias ["crash_…:released_b"]
[recovery] preimagen recuperada del ledger, cobrando la pierna de Soroban
[recovery] completado {"release_a":"ed33bcf8501f351446d55745bf0d6354ff342f5ad18c7c3bee14ba17aef96712"}
estado on-chain: "Released"
```

Corrido contra ambas testnets, 24 s de punta a punta:

| Paso | Cadena | Tx |
|---|---|---|
| lock A | Soroban | `6b5f0865c9daedf8a5c370dabecc2e32bf1f46568f6304b7f09aaf1dfb21f3ab` |
| lock B | XRPL | `41BBE9B40A23B5D699482B5DF12995E791636DD3A4D5B16357548D33D836B229` |
| reveal | XRPL | `591610E4143F041B3A2C9CCD343FF7291FC4BCB8B3446C740F5AFE187ECBFB3E` |
| release A | Soroban | `d668659c9a0099c40b37380c48eb7aa7a73d4ce0d012cc92b3c471af9eccf1bb` |

`secret_hash` = `8593e67e…4a6868`, `condition` = `A0258020` + ese mismo hash + `810120`.

```bash
npm run test:live -w @micopay/api
```

**Custodia, dicho con precisión:** en este flujo la API firma con **sus propias llaves de
demo** —hace de las dos partes— no con las de ningún usuario. El flujo no custodio entre
dos agentes independientes es el de [`packages/xrpl-bridge`](packages/xrpl-bridge/README.md)
(`agent_a.js` / `agent_b.js`).

La consola tiene la pestaña **🌉 Swap XRPL↔Soroban**: enseña este swap con cada tx
enlazada a su explorador, y un botón que ejecuta uno nuevo contra las dos testnets.

## Estado de la capa de pago x402

El plan de split daba por abiertos dos agujeros. **Los dos están cerrados** en el código
que se migró, y conviene saberlo antes de decidir si el demo se puede enseñar:

- **SEC-13** — `verifyPayment()` ya no se queda en parsear la estructura del XDR:
  envía la transacción a Horizon y exige confirmación (`middleware/x402.ts`), con
  respaldo a comprobar si esa misma tx ya se liquidó. Someterla server-side es además
  cómo se obtiene verificación real de firma: Horizon rechaza un sobre mal firmado.
- **SEC-14** — el anti-replay ya persiste: `useDatabase` pasa a `true` tras
  `initX402Tables()`. **Caveat:** si la base no arranca, cae a un `Set` en memoria con
  solo un `console.warn`, y ahí la ventana de replay se reabre en cada reinicio.
- El bypass `mock:` está detrás de `X402_MOCK_MODE` **y** `NODE_ENV !== production`.

Nada de esto afectaba a la atomicidad del swap, que es criptográfica, sino a la capa que
lo coordina.

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

Los tests no necesitan Postgres ni red. Si algo de eso hace falta para que pasen, es un
test mal escrito: lo que se prueba es la lógica, no que la testnet esté de buenas.

## Licencia

MIT © Micopay.
