# `cash.ts` y `fund.ts` — por qué vuelven

**Propuesta, no hecho consumado.** El §3.2 del plan de split las listaba como retail y las
borré siguiendo esa lista. Al revisar el resultado, la clasificación no se sostiene.

---

## Lo que decía el plan

> **Rutas que NO se migran** (duplicados retail — la versión viva está en
> `micopay/backend`): `auth.ts`, `merchants.ts`, `stellar.ts`, `trades.ts`, `users.ts`,
> `trade-messages.ts`, `cash.ts`, `cetes.ts`, `blend.ts`, `fund.ts`.

La justificación es *"la versión viva está en `micopay/backend`"*. Se puede comprobar, y
para 5 de las 12 es falso:

| Ruta | ¿Existe en `micopay/backend`? |
|---|---|
| `auth`, `users`, `kyc`, `ramp`, `merchants`, `trades`, `stellar` | **Sí** |
| `cash`, `fund`, `cetes`, `blend`, `trade-messages` | **No** |

Para esas cinco, borrarlas no las movía de sitio: **las eliminaba**.

## Por qué estas dos y no las otras tres

`cetes`, `blend` y `trade-messages` son retail aunque no tengan gemelo: inversiones y chat
sobre trades. Que desaparezcan del repo de agentes es correcto.

`cash` y `fund` no:

- **`/api/v1/cash/*`** es el pitch entero de este repo. El README de la consola dice *"La
  primera API que da a agentes IA acceso a efectivo físico en México"*. Eso es esta ruta.
  Depende de `services/p2p.ts`, que es autocontenido y **no toca la base de datos**.
- **`/api/v1/fund`** es el agente pagando al protocolo que acaba de usar — el argumento de
  "x402 se sostiene solo". Cobra USDC contra la misma cuenta de plataforma que usa el
  middleware de x402.

Ninguna de las dos tiene que ver con el flujo retail de cash-out del APK.

## Qué rompía haberlas borrado

**La pestaña "⚡ Demo" — la primera que se ve — rota en 2 de 5 pasos.** `demo.ts` llama:

```
demo.ts:193   /api/v1/cash/agents    → 404
demo.ts:225   /api/v1/cash/request   → 404
```

Y peor que un 404: `demo.ts` hace **7 `horizon.submitTransaction`** y manda las
transacciones **antes** de llamar al endpoint. O sea que pagaba USDC de verdad por dos pasos
que devolvían "ruta no encontrada", y como hace `await s3.json()` sobre la respuesta de
error, los pintaba en la UI como si fueran resultados legítimos.

**La pestaña "💚 Fund MicoPay" — muerta entera.** `FundWidget.tsx:27` llama
`/api/v1/fund/stats`, y el propio widget muestra ejemplos de `curl` apuntando a un endpoint
inexistente.

## Qué se hizo

Recuperados de `micopay-protocol@0b81a78` **sin modificar una línea**:

```
routes/cash.ts     365 líneas
routes/fund.ts     185 líneas
services/p2p.ts    259 líneas   (autocontenido, sin base de datos)
```

Registrados en `index.ts`. Comprobado que no queda ningún endpoint que la consola o el guion
del demo llamen y no exista.

Verificado contra la API levantada: `/api/v1/cash/agents` y `/api/v1/fund/stats` responden
200.

## Lo que le toca decidir al equipo

Si `cash` y `fund` deben vivir aquí, en `micopay/backend`, o en los dos. Lo que no puede
seguir es que la consola y el guion del demo llamen a rutas que no existen en ningún repo.

Y de paso: **el §3.2 del plan tiene cinco entradas con una justificación que no se cumple.**
Conviene revisarlo antes de usarlo como referencia para otra cosa.
