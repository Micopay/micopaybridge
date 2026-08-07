# Contributing to MicoPay Bridge

Este repo es el puente XRPL↔Stellar y el stack de agentes. **No es el de la app móvil**
— eso vive en [`micopay-protocol`](https://github.com/ericmt-98/micopay-protocol), tiene
su propio `CONTRIBUTING.md` y su propio programa de Drips.

> Antes de abrir un PR, lee este archivo entero. Es el contrato contra el que se revisa.

---

## Alcance

Dentro:

- `packages/xrpl-bridge/` — pierna XRPL: traducción cripto/tiempo, relay, suite de fallos
- `packages/types/`, `packages/sdk/` — tipos y `AtomicSwapClient`
- `apps/api/` — API de protocolo x402
- `apps/agent/` — AIGENTS
- `apps/web/` — consola del demo
- `contracts/`, `circuits/` — Soroban y Noir

Fuera, y no por gusto: **nada que toque el producto retail**. Si un cambio necesita datos
o endpoints de `micopay/backend`, no se resuelve copiando código aquí — ver la frontera
en el [README](./README.md), que sigue abierta.

---

## Los tres gates

CI corre estos tres y ninguno lleva `continue-on-error`. Si uno falla, el PR no entra.

```bash
npm install
npm run typecheck
npm test
```

```bash
cd contracts && cargo test --workspace
```

Reglas que salieron de romperlas antes:

- **Todo workspace con TypeScript declara su script `typecheck`.** Si no lo declara,
  turbo no tiene qué correr y el gate pasa en vacío sin revisar nada.
- **Nada de `any` ni `@ts-ignore` para poner verde el gate.** Si tsc encuentra algo,
  suele tener razón: en esta migración destapó una dependencia que faltaba y dos campos
  cuyo tipo no coincidía con lo que la base devuelve en runtime.
- **Los tests que cuestan dinero o red no van en `test`.** Van en `test:live` y se corren
  a mano: la suite contra testnets de `xrpl-bridge` (~5 min, necesita identidades
  fondeadas) y el smoke del intent parser de `apps/agent` (necesita `ANTHROPIC_API_KEY`).

En Windows, `cargo test` nativo puede no compilar por falta de linker. La salida es
correrlo en contenedor, que además es el mismo SO que CI:

```bash
docker run --rm -v "$PWD/contracts:/w" -w /w rust:1 cargo test --workspace
```

---

## Antes de commitear

- **Ningún `.env`, llave ni semilla.** Este repo es **público**. Al migrar desde
  `micopay-protocol` ya se coló un `.env` real una vez.
- **Ningún ID de contrato del stack móvil.** El escrow del móvil y el del servicio x402
  son dos contratos distintos que divergieron en abril y no son intercambiables.
- Si tocas la pierna XRPL, corre `npm run test:live -w @micopaybridge/xrpl-bridge`
  antes de pedir revisión. Los caminos de fallo son el producto, no un extra.

## Estilo de commits y PRs

- Un cambio lógico por commit.
- Título en imperativo y corto (`fix: cursor del relay no avanza tras un fallo`).
- La descripción responde: qué cambió, por qué, cómo se probó.
- Si algo se dejó fuera a propósito, dilo. Un hueco documentado es trabajo; uno callado
  es una trampa para el siguiente.

## Código de conducta

Directo, amable, y asumiendo buena intención.
