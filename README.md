# MicoPay Bridge

> **A P2P market for AI agents, secured by escrows.** Two agents that have never met settle a
> trade across XRPL and Stellar atomically — no custodian, no account, no prior registration —
> and can cash out to physical pesos through the [MicoPay](https://github.com/Micopay/micopay-protocol)
> network. It is the same HTLC trust model the MicoPay app already uses between people, applied
> to machines. The difference is that machines never need a timeout sized for someone who might
> be asleep.
>
> **Running on mainnet:** a Stellar↔XRPL atomic swap and user-signed XRPL account activations,
> with every transaction linked in [Evidencia on-chain](#evidencia-on-chain).
>
> The documentation below is in Spanish. **The [open issues](https://github.com/Micopay/micopaybridge/issues)
> are in English** — that is where to start if you want to contribute.

**Un mercado P2P para agentes de IA, construido sobre escrows y atomic swaps.**

Dos agentes que no se conocen ni confían el uno en el otro acuerdan un intercambio, lo
liquidan en dos cadenas distintas y ninguno puede quedarse con el dinero del otro. Sin
custodio, sin cuenta, sin registro previo. La garantía no es una empresa: es que las dos
piernas del intercambio están atadas al mismo secreto criptográfico.

## Qué es

El **bazaar** es el mercado: un agente publica lo que ofrece y lo que quiere, otros
cotizan, y al aceptarse una cotización se liquida on-chain.

| Endpoint | Qué hace |
|---|---|
| `POST /api/v1/bazaar/intent` | publicar lo que ofreces y lo que buscas |
| `POST /api/v1/bazaar/quote` | cotizar el intent de otro |
| `POST /api/v1/bazaar/accept` | aceptar y liquidar |
| `GET /api/v1/bazaar/feed` | qué se está ofreciendo ahora |
| `GET /api/v1/bazaar/reputation/:address` | historial de un agente en este mercado |

El **puente XRPL↔Stellar** es cómo se liquida cuando las dos partes están en cadenas
distintas: un escrow nativo de XRPL contra un HTLC en Soroban, gobernados por una sola
preimagen. Ver [El swap de dos piernas](#el-swap-de-dos-piernas).

**x402** es cómo se paga por consumir el protocolo: un agente que llama a un endpoint de
pago recibe un `402`, paga en USDC y reintenta. Sin cuentas ni API keys — el pago *es* la
autenticación.

**Las credenciales ZK** (circuitos Noir en `circuits/`) permiten a un agente demostrar que
tiene derecho a algo sin revelar quién es ni enlazar sus operaciones entre sí.

## Para quién

Para agentes, no para personas. La consola de `apps/web` existe para que un humano pueda
*mirar* lo que pasa, pero ningún agente la usa: hablan HTTP contra la API directamente.
Por eso no hay pantalla de login en ningún sitio — no habría quién la llenara.

## Reputación: la del mercado es propia

Un agente acumula historial **en este mercado**: cuántos intercambios publicó, cuántos
cerró, cuántos canceló y qué volumen movió. Vive en `agent_history`, se escribe sola con
la actividad del bazaar y **no depende de MicoPay ni de ningún sistema externo**.

Es distinta de la reputación de **comercios** de la red de efectivo de MicoPay, que solo
tendrá sentido el día que el bazaar se conecte a ella. Esas rutas
(`/api/v1/reputation/:address` y `/api/v1/merchants`) responden hoy **501**: la tabla que
consultan está vacía en este repo, y devolver números sembrados sobre comercios que no
existen sería peor que no responder. Se encienden con
`MICOPAY_CASH_NETWORK_ENABLED=true` cuando exista la fuente; el contrato que tendría que
implementar el otro lado está en
[`docs/CONTRATO_REPUTACION.md`](docs/CONTRATO_REPUTACION.md).

## Qué esperamos

Por orden, no por fecha:

1. ~~**Cerrar el ciclo en mainnet.**~~ Hecho: swap de dos piernas y activación en
   mainnet, ver [Evidencia on-chain](#evidencia-on-chain).
2. ~~**Desplegar el protocolo.**~~ Hecho en Railway; falta que la consola de
   `micopay.com.mx/bridge` apunte a esa API.
3. **Que el mercado tenga agentes de verdad**, no dos guiones de demo — que es cuando
   `agent_history` empieza a significar algo.
4. **Conectar el bazaar a la red de efectivo de MicoPay.** Ese es el día que un agente
   puede terminar un intercambio en pesos físicos, y el día que la reputación de comercios
   se enciende.
5. **Reputación portátil.** Los circuitos de `circuits/reputation_v1` apuntan a que un
   agente pruebe su tier sin revelar su historial ni enlazar sus direcciones.

Lo que **no** es este repo: nada del APK ni de la app móvil retail. Eso vive en
[`micopay-protocol`](https://github.com/Micopay/micopay-protocol).

## Estado del despliegue

| Pieza | Dónde | Estado |
|---|---|---|
| API (`apps/api`) | [api-production-9ec74.up.railway.app](https://api-production-9ec74.up.railway.app/health) | viva, `network: PUBLIC` |
| Consola con API | [web-production-eb54.up.railway.app](https://web-production-eb54.up.railway.app/#activate) | viva, apunta a la API de mainnet |
| Consola (`apps/web`) | [micopay.com.mx/bridge](https://micopay.com.mx/bridge) | publicada, **sin API a la que llamar** |
| `AtomicSwapHTLC` | Stellar mainnet | desplegado — ver [Evidencia on-chain](#evidencia-on-chain) |
| Pierna XRPL | XRPL mainnet | swap y activación ejecutados — ver [Evidencia on-chain](#evidencia-on-chain) |

La consola de `micopay.com.mx/bridge` dice en pantalla que no tiene backend, en vez de
fallar en silencio. Se recompila con `VITE_API_URL` apuntando a la API de arriba y las
pestañas vuelven.

## Evidencia on-chain

Todo lo de esta sección se puede comprobar en un explorador público, sin pedirnos nada.
Verificado contra la cadena el 2026-10-02.

### Swap atómico Stellar ↔ XRPL en mainnet (2026-08-14)

Un swap de dos piernas ejecutado con `npm run test:live:mainnet -w @micopay/api`. Las
cuatro transacciones ocurren en 22 segundos y las dos cadenas quedan atadas al mismo
secreto:

| # | Cadena | Operación | Transacción | Hora (UTC) |
|---|---|---|---|---|
| 1 | Stellar | `lock` — 0.5 XLM, `secret_hash = 3c2753…b694` | [`3ea23f11…`](https://stellar.expert/explorer/public/tx/3ea23f111d682e7f1bd20510a84d177d75d50a9f9449a323ba043c1ce8d6fb51) | 06:32:25 |
| 2 | XRPL | `EscrowCreate` — 1 XRP, `Condition` con fingerprint `3C2753…B694` | [`C5716941…`](https://livenet.xrpl.org/transactions/C57169418DAFE632568C1589457F64612E8908B598D88D19742A017671889636) | 06:32:31 |
| 3 | XRPL | `EscrowFinish` — `Fulfillment` revela la preimagen `4290d7…11d2` | [`731495D1…`](https://livenet.xrpl.org/transactions/731495D15390B777DDD117170EC48EE619F89A7D37BC6978D4AD93C796094B74) | 06:32:41 |
| 4 | Stellar | `release` — con la misma preimagen `4290d7…11d2` | [`e659177c…`](https://stellar.expert/explorer/public/tx/e659177c7d5ed508f95751908e97f9c2a9bd9c4cafadf878d9bcbd9f17fe234d) | 06:32:47 |

Para comprobar que es **un** swap y no dos escrows sueltos:

```bash
# la preimagen que se publicó en XRPL (paso 3) y se usó en Stellar (paso 4)…
node -e 'console.log(require("crypto").createHash("sha256").update(Buffer.from("4290d7e4f7895a6a04e7b41b9bfbd2e0beacde6358a03e07e834ada544f811d2","hex")).digest("hex"))'
# …da 3c275318762292dfd76e3011f3785658622f1f993727577b7ed612f33499b694:
# el secret_hash del lock en Stellar (paso 1) y el fingerprint de la Condition en XRPL (paso 2)
```

El `swap_id` del `release` (`b1066bcb…d726`) es `sha256(secret_hash)`, como define el
contrato. El `EscrowCreate` lleva el source tag `2607170001`.

**Límites, dichos de frente:** las dos partes son wallets del equipo, y en la pierna de
Stellar el iniciador y la contraparte son la misma cuenta (el contrato no exige que
difieran). Prueba que el mecanismo funciona en mainnet con dinero real; no prueba que dos
agentes independientes lo hayan usado.

### Activación de cuentas XRPL firmada desde Xaman (2026-09-03)

Un self-escrow de 1 XRP que el usuario firma desde su propia wallet: el backend arma el
payload y **nunca firma**. `Destination == Account` y sin `FinishAfter`, así que el XRP
solo puede volver a su dueño. Se probaron las dos formas de recuperarlo:

| Escrow | Cuenta | Recuperado por | Transacciones |
|---|---|---|---|
| 1 | `rETyvXg5…h5cY` | el dueño, con "Reclamar mi XRP" | [`CD97BBD6…`](https://livenet.xrpl.org/transactions/CD97BBD625B1AF16595652A2670DB9C2B44022E4A43A172CA590C2B64CB45B1A) → [`1FBC6AB5…`](https://livenet.xrpl.org/transactions/1FBC6AB5B9370CB388FA3C5A7446D6466F731FD12F519FF44FD1F922267402EF) |
| 2 | `rQaPLVuF…i9t` | el dueño, con "Reclamar mi XRP" | [`707F4C2B…`](https://livenet.xrpl.org/transactions/707F4C2B9D1183866BAE406875E39F3B7CE885153B69BD5B1BEDD592F2167532) → [`018DE208…`](https://livenet.xrpl.org/transactions/018DE208A66EF25789058B0DCE80F29537876BB5DF78AA5CDBD4082A75812CF3) |
| 3 | `rQaPLVuF…i9t` | una **tercera cuenta**, tras vencer `CancelAfter` | [`F801DF6F…`](https://livenet.xrpl.org/transactions/F801DF6FCC8479843EF52944D5702591B63D4EC8D7DFCCEDD9D43396155DEBCA) → [`783FFDAB…`](https://livenet.xrpl.org/transactions/783FFDAB4D1C4CF019C1384496CCA4C3A47B7BC45DF7A0BE1BF2DC8B19FBB8A3) |

El tercer caso es el que usa el `activationSweeper`: cualquiera puede mandar el
`EscrowCancel` cuando vence el plazo, pero el XRP vuelve siempre al dueño.

### Contrato y cuentas

| Qué | Dirección |
|---|---|
| `AtomicSwapHTLC` (Stellar mainnet) | [`CB5TCVEB…ZUGPU`](https://stellar.expert/explorer/public/contract/CB5TCVEBQDUI2GSQZLMUA2H7FHFHCQLKVGZYJZBECPDVKZCI3PFZUGPU) — wasm `a5e4bc1d…6ede`, fuente **sin verificar** en stellar.expert |
| Deployer Stellar | [`GBW7XHCA…BA3R`](https://stellar.expert/explorer/public/account/GBW7XHCAX5IWIMZ44KIXLBJNM5DPQKCJXUGAFTJXV3RG6OAFWV23BA3R) |
| Wallets XRPL del equipo | [`rETyvXg5pFdFL4KxfZASejmpGuh2urh5cY`](https://livenet.xrpl.org/accounts/rETyvXg5pFdFL4KxfZASejmpGuh2urh5cY), [`rQaPLVuFeb8LdwPx51c4wP6Kb9MNHN9i9t`](https://livenet.xrpl.org/accounts/rQaPLVuFeb8LdwPx51c4wP6Kb9MNHN9i9t) |
| Source tag XRPL | `2607170001` |

Los demás pagos que aparecen en esas cuentas XRPL (montos ínfimos de remitentes
desconocidos) son spam de la red, no actividad nuestra.

## Qué hay en el repo

| Ruta | Qué es | Estado |
|---|---|---|
| `packages/xrpl-bridge/` | Pierna XRPL: traducción cripto/tiempo, relay de dos ledgers, suite de fallos y agentes de demo | ✅ verificado contra testnets reales — [README](packages/xrpl-bridge/README.md) |
| `packages/types/` | Tipos compartidos | migrado |
| `packages/sdk/` | `AtomicSwapClient` (`lock/release/refund/getStatus`) | migrado, verificado contra testnet |
| `apps/api/` | API de protocolo x402 | migrado **filtrado** — ver abajo |
| `apps/web/` | Consola de demos del agente (sin login: es un observador humano, no algo que un agente vea) | migrado **filtrado** — ver abajo |
| `contracts/htlc-core/` | Primitivas HTLC compartidas (`MIN_TIMEOUT_LEDGERS`, TTL) | migrado tal cual |
| `contracts/atomic-swap/` | `AtomicSwapHTLC` — el contrato que la pierna XRPL espeja | migrado tal cual |
| `contracts/micopay-escrow/` | Escrow del **servicio x402** | migrado tal cual |
| `contracts/zk-verifier/` | `ZkVerifierRegistry` | migrado tal cual |
| `circuits/` | Noir: `access_credential_v1`, `poseidon_preimage`, `reputation_v1` | migrado tal cual |
| `docs/` | Especificaciones ZK, auditorías y planes | migrado tal cual — [leer con advertencia](docs/README.md) |

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

El estado vive en `swap-store/`, **un archivo por swap**, con escritura atómica y carga al
arrancar. No es una base de datos: es el mínimo para que ni un reinicio ni una segunda
instancia pierdan de vista dinero bloqueado.

Un solo JSON con todos los swaps no servía: dos procesos —dos instancias detrás del
balanceador, o un script `test:live` con la API levantada— lo cargaban, cada uno escribía
el suyo y el segundo borraba el del primero. Con un archivo por swap, dos procesos que
tocan swaps distintos ni se ven. Para el mismo swap hay **fusión monótona**: este estado
solo crece —las transacciones se añaden, nunca se quitan, y el status avanza— así que dos
escrituras concurrentes convergen en vez de pisarse.

```bash
npm run test:concurrency -w @micopay/api
```

Lanza procesos de verdad, que es lo único que prueba esto:

```
[1] swaps distintos, dos procesos → SWAP_A.json, SWAP_B.json
    OK — los dos sobreviven
[2] el mismo swap, dos procesos → status=released_b txs=lock_a,lock_b,release_b
    OK — ninguna escritura perdió la de la otra
```

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

**`apps/api` traía su propio SEC-02**, separado del que ya se cerró en `micopay/backend`
el 28 de julio: `cash.ts` migró con el QR llevando el preimage HTLC
(`micopay://claim?...&secret=<preimage>`), así que quien pagara $0.01 podía liberar el
escrow sin entregar efectivo. Cerrado con el mismo diseño — token opaco de un solo uso,
solo se guarda el sha256, TTL 15 min. **No cierra la falta de autenticación de
comercios**: el canje sigue siendo del portador, que es el WAVE5 Issue 8 que el equipo
ya tiene abierto en el producto retail — la misma decisión de roles, ahora también
pendiente aquí. Detalle en [`docs/SEC-02_EN_APPS_API.md`](docs/SEC-02_EN_APPS_API.md).

`fund/demo` mandaba 0.10 USDC reales sin pago ni autenticación, con la llave del demo,
alcanzable por cualquiera que conociera la URL en un repo público. Ahora detrás de
`X402_MOCK_MODE` + fuera de producción, con límite de 3/min.

## La frontera con `micopay-protocol`

| | `micopaybridge` (aquí) | `micopay-protocol` |
|---|---|---|
| Producto | Agentes, x402, ZK, puente cross-chain | APK + app móvil retail |
| Backend | `apps/api` — protocolo x402 | `micopay/backend` — en producción |
| Escrow Soroban | `contracts/micopay-escrow` — el del servicio x402 | `micopay/contracts/escrow` — el del móvil, `CB4M5777…ALO3HZ` |
| Se despliega | no todavía | sí |

Los dos escrows **divergieron en abril y no son intercambiables**. Difieren en 78 líneas.
Unificarlos sería un cambio de comportamiento en producción disfrazado de limpieza.

El acoplamiento con el otro repo **cabe en un archivo**:
[`lib/reputation-source.ts`](apps/api/src/lib/reputation-source.ts). No queda ni un
`import` de `db/merchants` en las rutas, y la ruta de reputación no sabe de dónde salen
los datos — hay un test que compara la respuesta con las dos fuentes posibles y exige que
sea idéntica. El día que el bazaar se conecte a la red de efectivo, pasar de leer el
esquema a consumir un endpoint versionado es una variable de entorno, no un refactor.

**Un fallo que salió al tocar esto:** la consulta de `/api/v1/reputation/:address` **no
filtraba por la dirección pedida**. Ordenaba por `verified_at` y devolvía `LIMIT 1`, así
que cualquier dirección válida obtenía siempre el mismo comercio — en la ruta cuya única
función es decidir si fiarse de uno en concreto, y que además cobra por responder.
Corregido, con test de regresión.

## Historial del split

Este repo salió de `micopay-protocol` en agosto de 2026. Lo que sigue es la contabilidad
de esa migración: qué se movió, qué se dejó fuera y por qué. Sirve para rastrear
decisiones, no para entender el producto.

### Origen del código migrado

Copia plana desde `micopay-protocol` en `0b81a78`. No se trajo historia: para rastrear un
archivo hay que buscarlo en el repo de origen a esa altura.

### Qué se quedó fuera de `apps/api`

Rutas retail cuya versión viva es `micopay/backend`: `auth`, `users`, `cetes`, `blend`,
`kyc`, `ramp`, `merchants`, `trade-messages`, `trades`, `stellar`. Con ellas se fueron
sus servicios (`etherfuse`, `merchant`, `p2p-registry`, `secret`, `trade`),
`db/auth.ts`, `middleware/auth.middleware.ts`, `lib/webhook-auth.ts`,
`lib/trade-auth.ts`, sus tests y la migración `002_etherfuse_ramp.sql`.

**`cash`, `fund` y `services/p2p.ts` NO están fuera — el §M2 del plan se equivocaba
para estos tres.** Su justificación era "la versión viva está en `micopay/backend`", y
ahí no existen: borrarlos no los movía de sitio, los eliminaba. `/cash/*` es el acceso a
efectivo físico que es el pitch del repo, y `/fund` es el agente pagando al protocolo.
Recuperados tal cual — `services/p2p.ts` es autocontenido. Detalle en
[`docs/SEC-02_EN_APPS_API.md`](docs/SEC-02_EN_APPS_API.md).

`routes/agent.ts` y `routes/swaps.ts` **sí están registrados** en `index.ts`. Llevaban
sin registrar desde el origen — plan y ejecutor existían pero no eran alcanzables por
HTTP, y el §M4.5 pide el flujo de punta a punta. Es el único cambio de comportamiento
hecho sin que el plan lo pidiera explícitamente; se revierte borrando dos líneas si el
equipo prefiere que sigan sin exponerse.

### Qué se quedó fuera de `apps/web`

`App.tsx` no tiene router: monta seis pestañas y nada más. Todo `src/pages/` era
**inalcanzable** — doce pantallas retail duplicadas de `micopay/frontend`, más
`BottomNav`, `Logo`, `MapSim`, `MerchantCard`, `Skeleton`, `services/api.ts` y las
imágenes de `public/` que solo usaba el mapa. Nada de eso se migró.

`SwapStatus.tsx` sí se migra aunque hoy no lo importa nadie: el §M5 del plan lo nombra
como material del demo, y es donde entrará la pierna XRPL cuando sustituya a
`ATOMIC_SWAP_CONTRACT_B`.

### Qué se archivó

`apps/agent/` (AIGENTS: intent parser, executor, tools — §2.1 del plan) se migró el
2026-08-07 y se archivó el 2026-08-08, en `archive/apps-agent/`, fuera del workspace
activo. Dos razones, las dos comprobadas ejecutando código, no leyéndolo:

1. **Nadie lo usa.** Ningún `package.json` del monorepo depende de `@micopay/agent`;
   `apps/api/routes/agent.ts` reimplementa su propio `planSwap` en vez de importarlo;
   nunca se había compilado.
2. **Su pieza central no puede funcionar.** `SwapExecutor` depende de
   `checkChainBLock()`, que no consulta nada — inventa un hash y lo devuelve como si
   fuera un lock real, siempre. Probado contra testnet: bloquea fondos de verdad en
   cadena A y después revienta siempre al liberar en cadena B, sin camino automático
   de refund para ese caso. Es más viejo que M4.5 — el mismo patrón de "cadena B
   simulada" que el puente XRPL reemplazó en el resto del repo, pero aquí nadie lo
   tocó porque nadie lo ejecutaba. Un solo commit toca `executor.ts` en toda la
   historia de este repo: el de migrarlo, copia tal cual desde `micopay-protocol`.

Lo que ya cumple el mismo objetivo (dos agentes, sin custodio, probado end-to-end):
[`packages/xrpl-bridge`](packages/xrpl-bridge/README.md) (`agent_a.js` / `agent_b.js`).
Detalle completo, con la corrida que lo prueba, en
[`archive/apps-agent/ARCHIVADO.md`](archive/apps-agent/ARCHIVADO.md).

`packages/sdk` no se archivó — su mecanismo (`lock`/`release`/`getStatus`) funciona
bien, verificado hoy contra testnet. Solo se quedó sin consumidor vivo.

### Qué falta migrar

Solo `contracts/micopay-badges`, y está **sin decidir**: el plan lo deja abierto en §2.3
y no aparece referenciado ni en `render.yaml` ni en `.env.example`.

`docs/xrpl-hackathon/`, que el §2.1 también lista, **no existe** en el repo origen:
buscado en todas las ramas remotas y en la historia completa. Ver
[SUBMISSION_CORRECCIONES.md](docs/SUBMISSION_CORRECCIONES.md).

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
