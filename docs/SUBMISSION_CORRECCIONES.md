# Correcciones al `SUBMISSION.md` de la convocatoria XRPL

Dos afirmaciones del `SUBMISSION.md` no coinciden con el código. Son las del §4 del plan
de split, verificadas aquí una por una contra los archivos.

> **El archivo no está en ninguno de los dos repos.** Buscado en `micopay-protocol` con
> `git ls-files`, en todas las ramas remotas tras `git fetch --all`, en la historia
> completa (`git log --all --diff-filter=A`) y en el disco: cero resultados. Tampoco
> existe `docs/xrpl-hackathon/`, que el §2.1 del plan lista como migrable. El plan se
> escribió desde la máquina de Eric, así que lo más probable es que el archivo viva ahí
> o solo en el portal de la convocatoria. Este documento deja las correcciones listas
> para aplicar en cuanto aparezca.

---

## Corrección 1 — el campo `chain` no está en el contrato

**Dice el submission:**

> Su schema `AssetInfo` tiene reservado un campo `chain` por activo desde el día uno.

**Lo que hay en el código:**

`AssetInfo` es una **interfaz de TypeScript**, off-chain, en
[`apps/api/src/routes/bazaar.ts:22`](../apps/api/src/routes/bazaar.ts):

```ts
interface AssetInfo {
  chain: string;
  ...
}
```

El struct que sí vive en el ledger, `AtomicSwap`
([`contracts/atomic-swap/src/lib.rs:19-28`](../contracts/atomic-swap/src/lib.rs)), **no
tiene ningún campo de cadena ni de metadatos de activo**:

```rust
pub struct AtomicSwap {
    pub initiator: Address,
    pub counterparty: Address,
    pub token: Address,
    pub amount: i128,
    pub secret_hash: BytesN<32>,
    pub timeout_ledger: u32,
    pub status: SwapStatus,
}
```

En todo `lib.rs` la palabra `chain` aparece **solo en comentarios**, nunca en un campo.

**Redacción corregida:**

> El schema `AssetInfo` de la capa de aplicación reserva un campo `chain` por activo. El
> contrato HTLC es deliberadamente agnóstico de cadena: no guarda metadatos de activo ni
> de red, porque la atomicidad la da el hash, no el ledger.

Esto no debilita el argumento, lo hace correcto: **un HTLC no necesita saber en qué
cadena está la otra pierna.** Es exactamente por eso que la pierna B pudo pasar de una
segunda instancia de Soroban a un escrow nativo de XRPL sin tocar el contrato.

---

## Corrección 2 — hay dos `MicopayEscrow` y el de producción no es el que se migra

**Dice el submission:** que `MicopayEscrow` corre el flujo retail de producción.

**Es cierto — pero de la otra copia.** Son dos contratos distintos que divergieron en
abril, y difieren en 78 líneas:

| Copia | Repo | Estado |
|---|---|---|
| `micopay/contracts/escrow` | se queda en `micopay-protocol` | el de producción, desplegado en `CB4M5777YFQWKGDUULCX5W6PXEDJSJARDTMH4VV6FXC4W4UPANALO3HZ` |
| `contracts/micopay-escrow` | migrado a `micopaybridge` | el del servicio x402 |

`micopay/contracts/TESTNET.md:3-4` lo dice explícito:

> Canonical IDs for the **mobile stack**. The `micopay-api` x402 service uses a separate
> escrow contract; **do not mix them**.

**Redacción corregida:**

> `MicopayEscrow` corre el flujo retail de producción de la app móvil
> (`CB4M5777…ALO3HZ`). El servicio x402 usa un contrato de escrow separado: divergieron
> en abril y no son intercambiables.

---

## Lo que sí verifiqué y está correcto

- `MicopayEscrow` implementa solo `initialize/lock/release/refund/get_trade`, sin
  disputas ni reputación.
- `AtomicSwapHTLC` es HTLC puro: sin comisiones, sin lógica de negocio, sin disputas.

## Lo que cambió desde que se escribió el plan

El §4 se redactó cuando la pierna B era `ATOMIC_SWAP_CONTRACT_B`, una segunda instancia
de Soroban. **Ya no.** Si el submission describe el cross-chain como pendiente o
simulado, esa parte también hay que actualizarla: hay un swap XRPL↔Soroban completo con
cuatro transacciones citables. Ver el [README](../README.md).
