# `apps/agent` (AIGENTS) — archivado el 2026-08-08

Migrado el 2026-08-07 (M1.4, `f6b0c7b`) siguiendo el inventario del plan de split
(§2.1: *"AIGENTS: intent parser, executor, tools"*). Sacado de `apps/*` — ya no es
parte del workspace activo — porque dos hallazgos de la misma tarde, ejecutando
código, no leyendo:

## 1. Nadie lo usa. Nunca se compiló.

- Ningún `package.json` del monorepo depende de `@micopay/agent` — ni siquiera
  `apps/api`.
- `apps/api/src/routes/agent.ts` (la ruta HTTP `/swaps/plan`) reimplementa su
  propio `planSwap` local en vez de importar `intent-parser.ts` de aquí.
- El `dev` de este paquete (`tsx watch src/index.ts`) no levanta nada: `index.ts`
  solo re-exporta funciones.
- No tenía `dist/` — nunca se había compilado, porque nada lo necesitó nunca.

## 2. Su pieza central (`SwapExecutor`) no puede funcionar. Nunca pudo.

`executor.ts` — el único componente que, según su propio comentario, *"touches
user funds"* — depende de `checkChainBLock()` para saber si la contraparte
bloqueó en la cadena B. Ese método no consulta nada: genera un hash inventado y
lo devuelve como si fuera un lock real, **de inmediato, siempre**. El comentario
dice *"In production: query contract events"* — nunca se implementó.

Probado ejecutándolo de verdad, con plan real y las identidades
`raul-bridge`/`mota-agent` contra testnet:

```
[Executor] Locked on chain A. swap_id=7802c9c1...
[Executor] Counterparty locked on chain B. swap_id=7802c9c1...   ← inventado
RESULT: {
  "status": "partial",
  "stellar_tx_hash": "7802c9c12b38fcd549eb86900318a69a114b62ef96aa29d17fc88fdf5aa062a4",
  "error": "Failed to release on chain B: Transaction failed on-chain: 0e1a5555..."
}
```

`release()` en cadena B revienta siempre contra un swap que nunca existió — 100%
de las veces, no intermitente. Y es peor que "no funciona": el único camino de
refund del executor vive en la rama de timeout ("contraparte no bloqueó a
tiempo"), que nunca se alcanza porque `checkChainBLock` "encuentra" algo al
instante. O sea que cada llamada real deja fondos bloqueados en cadena A **sin
ningún camino automático de vuelta** — solo refund manual, pasado el timeout,
por fuera de esta clase.

**No es un bug de la migración.** `git log --oneline -- apps/agent/src/executor.ts`
tiene un solo commit, el de migrar (`f6b0c7b`), copia tal cual. El stub ya venía
así desde `micopay-protocol`, de antes del split — el plan fecha este paquete en
"último cambio abr-2026", meses antes de que existiera el puente XRPL real. Es
más viejo que M4.5: se escribió cuando "chain B" todavía era, a propósito, una
segunda instancia simulada — exactamente el patrón que M4.5 vino a reemplazar en
todo el resto del repo, pero que aquí nadie tocó porque nadie lo ejecutaba.

**Sin registro previo de por qué seguía así.** Grep en todo `docs/` — cero
menciones de `executor.ts`, `SwapExecutor`, o `apps/agent`. No fue una decisión
escrita de dejarlo pendiente; fue un punto ciego, porque nada en el repo lo
ejercitaba para que alguien lo notara.

## Lo que SÍ funciona, si esto se retoma algún día

`packages/sdk` (`AtomicSwapClient` — `lock`/`release`/`getStatus`) está bien: se
probó en aislado hoy mismo contra testnet real y tenía dos bugs propios (cuenta
dummy sin fondear, decodificación del enum de status), los dos arreglados y
re-verificados. El problema nunca fue el SDK — fue el `checkChainBLock` fake de
este `executor.ts`.

## Lo que ya resuelve lo mismo, probado end-to-end

`packages/xrpl-bridge/agent_a.js` + `agent_b.js` — el flujo real de dos agentes
sin custodio, corrido contra testnets reales, documentado en
`packages/xrpl-bridge/README.md`. Es el M5 del plan (*"dos agentes cerrando un
swap XRPL↔Stellar sin custodio"*) ya cumplido, por otro camino. Reescribir
`executor.ts` contra el puente real sería duplicar eso, no complementarlo.

## Si alguien quiere revivirlo

`git mv archive/apps-agent apps/agent` lo regresa al workspace tal cual estaba.
Nada se borró.
