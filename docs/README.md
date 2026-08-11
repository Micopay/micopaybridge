# docs/

## Qué hay aquí

| Carpeta | Qué es |
|---|---|
| [`zk-agent-credentials/`](zk-agent-credentials/) | Especificación, auditorías, planes y pitch de las credenciales ZK para agentes (15 archivos) |
| [`ZK-as-a-Service/`](ZK-as-a-Service/) | El README largo de ZKaaS: arquitectura, modelo de negocio y roadmap |
| [`SUBMISSION_CORRECCIONES.md`](SUBMISSION_CORRECCIONES.md) | Las dos correcciones factuales del §4 del plan de split, verificadas contra el código |

## Léelos con esta advertencia

**Todo lo de `zk-agent-credentials/` y `ZK-as-a-Service/` se migró tal cual desde
`micopay-protocol` en `0b81a78`, y se escribió ANTES del split.** No se editó ni una
línea a propósito: son el registro de cómo se pensó cada cosa, y reescribirlos para que
encajen con la estructura de hoy los convertiría en otra cosa.

Consecuencias al leerlos:

- **Las rutas de archivo pueden apuntar al otro repo.** Lo que citan como `micopay/` o
  como rutas retail de `apps/api` vive en
  [`micopay-protocol`](https://github.com/ericmt-98/micopay-protocol), no aquí. Ejemplo
  concreto: `BASE_BRIDGE_PLAN.md:95` cita `apps/api/src/routes/cash.ts`, que
  deliberadamente **no** se migró (§3.2 del plan).
- **Lo que digan del cross-chain está desactualizado.** Se escribieron cuando la pierna B
  era `ATOMIC_SWAP_CONTRACT_B`, una segunda instancia de Soroban. Desde M4.5 es un escrow
  nativo de XRPL, con un swap completo y cuatro transacciones citables — ver el
  [README raíz](../README.md).
- **Los estados y porcentajes son de su fecha, no de hoy.** `STATUS.md` y los planes con
  fecha en el nombre son fotos de un momento.

Para el estado actual manda el [README raíz](../README.md); estos documentos explican el
porqué, no el ahora.
