# Mainnet Gate — estado verificado 2026-09-01

Todo lo de aquí se comprobó contra la cadena, el repo y los servicios
en vivo el 2026-09-01, no
contra notas anteriores. Los números que no pude verificar están marcados
como tales.

Panel del Hacker Dashboard hoy: *"Your project isn't eligible yet — Book
time with a mentor to validate your mainnet deployment to stay in the
running."* El gate sigue abierto; falta agendar.

---

## 1. Lo que ya está en mainnet

### Stellar / Soroban

| Dato | Valor |
|---|---|
| Contrato `AtomicSwapHTLC` | `CB5TCVEBQDUI2GSQZLMUA2H7FHFHCQLKVGZYJZBECPDVKZCI3PFZUGPU` |
| Creador | `GBW7XHCAX5IWIMZ44KIXLBJNM5DPQKCJXUGAFTJXV3RG6OAFWV23BA3R` |
| Desplegado | 2026-08-14 |
| Estado on-chain | 2 eventos, 2 entradas de storage, `errors: null` |
| Verificación de código en stellar.expert | **`unverified`** |

https://stellar.expert/explorer/public/contract/CB5TCVEBQDUI2GSQZLMUA2H7FHFHCQLKVGZYJZBECPDVKZCI3PFZUGPU

### XRPL

| Cuenta | Balance | Escrows abiertos |
|---|---|---|
| `rETyvXg5pFdFL4KxfZASejmpGuh2urh5cY` (initiator) | 5.999579 XRP | 0 |
| `rQaPLVuFeb8LdwPx51c4wP6Kb9MNHN9i9t` (counterparty) | 3.999993 XRP | 0 |

`OwnerCount: 0` en ambas — el swap del 14 ago cerró limpio, no quedó nada
colgado.

### Transacciones con el source tag `2607170001`

Las únicas que existen hoy en mainnet:

| Tipo | Hash | Ledger | Resultado |
|---|---|---|---|
| `EscrowCreate` | `C57169418DAFE632…` | 106282703 | `tesSUCCESS` |
| `EscrowFinish` | `731495D15390B777…` | 106282705 | `tesSUCCESS` |

### Saldos operativos

- `mainnet-bridge` (Stellar): **5.2283611 XLM**. Alcanza para invocaciones
  (~0.1–0.2 XLM), **no** para volver a subir el wasm (costó 7.29 XLM).
- XRPL: 10 XRP entre las dos wallets, reserva base incluida.

---

## 2. Estado del código

- `npm run build` — 4/4 tareas verdes
- `npm test -w @micopay/api` — **200 pasan, 1 skip, 1 falla** (la rama se
  rebaseó sobre `upstream/main`, así que hereda la suite de bazaar entera)
  - La que falla es `agent-execute.test.ts`: necesita Postgres en
    `localhost:5432` (`ECONNREFUSED`). No es del flujo de activación.
- Source tag cableado en los 5 constructores de tx de `lib/xrpl-leg.ts`,
  incluido `activationTxJson` — el payload que firma el usuario final desde
  Xaman lo lleva.
- RPC Soroban `soroban-rpc.mainnet.stellar.gateway.fm`: `healthy`.
  **No usar `mainnet.sorobanrpc.com`** — dio `transaction submission
  timeout` dos veces el 14 ago. `render.yaml:20` todavía lo tiene puesto.

---

## 3. Entregables del §8 — checklist

| Entregable | Estado |
|---|---|
| App viva en mainnet | ✅ web-production-eb54.up.railway.app y api-production-9ec74.up.railway.app; `/health` responde `network: PUBLIC` |
| Repo público con README + LICENSE | ✅ `Micopay/micopaybridge` y `Micopay/micopay-protocol`, ambos PUBLIC + MIT |
| Pitch deck | ✅ `MicoPay_Atomic_Bridge_CORREGIDO.pdf`, 10 láminas — decía "testnet" en 3 lugares, se le anexa una lámina de estado en mainnet |
| Video ≤3 min | ⚠️ el de la ficha (`youtube.com/watch?v=2XfkGeQFXik`) es de julio y es testnet — sin confirmar si sirve |
| Resumen de métricas | ver §4 |

---

## 4. Resumen de métricas (honesto)

| Métrica | Valor |
|---|---|
| Transacciones en mainnet con el source tag | 2 |
| Direcciones distintas que firmaron | 2 |
| Volumen movido | 1 XRP |
| **Cuentas que cuentan para las 300** | **0** |

Las dos direcciones son del propio equipo. El T&C §7 prohíbe self-dealing,
así que no suman. El conteo real arranca cuando firme la primera persona
ajena al equipo.

---

## 5. Lo que bloquea, en orden

1. **Agendar la reunión de validación.** Cuesta $0 y es lo que el panel
   pide. Sin eso el proyecto no entra al leaderboard aunque el resto esté
   perfecto.
2. **El video.** Es el único entregable del §8 que sigue sin resolver, y
   faltar a uno es descalificación.
3. **Cuál repo miran los jueces.** La ficha del reto apunta a
   `micopay-protocol`; todo el XRPL vive en `micopaybridge`. Cerrarlo con
   Mota o actualizar la ficha.
4. **PR #3** (`Micopay/micopaybridge#3`) — abierto desde el 14 ago, sin
   reviews. Está `MERGEABLE` / `CLEAN`: lo detiene la falta de revisión, no
   el diff. La rama ya se rebaseó sobre `upstream/main` y pasa la suite.
5. **`XRPL_SWEEPER_SEED` no está configurado.** El `activationSweeper` solo
   loguea avisos: el XRP que bloqueen los usuarios no se les regresa solo
   hasta que alguien mande el `EscrowCancel`.

---

## 6. Opcional, ayuda en la revisión

Verificar el código del contrato en stellar.expert (hoy `unverified`).
Un contrato con fuente verificada es más fácil de defender ante el jurado
que uno que solo se ve como wasm.
