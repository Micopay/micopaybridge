# SEC-02 en `apps/api` — el QR llevaba el preimage HTLC

**Propuesta, no hecho consumado.** Es el port del arreglo que ustedes ya hicieron en
`micopay/backend` el 2026-07-28. Se aplica aquí porque `cash.ts` tenía el mismo agujero y
este repo es **público**.

---

## Qué había

`routes/cash.ts`, tal cual venía de `micopay-protocol`:

```js
// Generate HTLC secret — the QR payload IS the secret preimage
const qrPayload = `micopay://claim?request_id=${requestId}&secret=${secret}&...`;
```

Y `POST /api/v1/cash/request` devolvía ese `qr_payload` **a quien llamaba**.

**El ataque:** cualquiera que pague $0.01 USDC obtiene la preimagen y libera el escrow
directamente contra el contrato, **sin entregar el efectivo**. No hace falta ser el
comercio ni escanear nada.

La propia respuesta afirmaba lo contrario:

> `"note": "HTLC locked on Soroban. Merchant notified. USDC releases only when merchant scans QR."`

Es falso: se libera con quien tenga la preimagen, y la tenía el que llamó.

## Qué se hizo — el mismo diseño que en `micopay/backend`

| Pieza | `micopay/backend` (julio) | `apps/api` (aquí) |
|---|---|---|
| Token opaco de 32 bytes | ✅ | ✅ |
| Solo se guarda el `sha256` | tabla `trade_claim_tokens` | `Map` con la misma forma |
| Un solo uso | `UPDATE … WHERE consumed_at IS NULL` | marcado sin `await` intermedio |
| Caducidad | `expires_at` | 15 min |
| El secreto sale solo al canjear | `getTradeSecret` | `POST /cash/request/:id/claim` |
| Sin token ni preimage en logs | ✅ | ✅ |

El QR pasa de llevar el secreto a llevar un token que **no sirve para nada por sí solo**:

```
micopay://claim?request_id=mcr-21fa3b7b&token=<64 hex>&amount_mxn=500
```

Y el preimage se entrega en el canje, contra un token válido, vigente, sin consumir y de
esa petición.

## Verificación

Seis tests en `src/__tests__/cash-claim.test.ts`, contra la app levantada:

- ni el QR ni la respuesta contienen la preimagen
- el token se canjea **una sola vez** (el segundo intento → `409 CLAIM_TOKEN_USED`)
- un token de **otra petición** no sirve (`404 INVALID_CLAIM_TOKEN`)
- un token inventado no sirve
- un comercio distinto al de la petición → `403 MERCHANT_MISMATCH`
- `/api/v1/fund/demo` responde `403` fuera de modo demo

Sin `if (…) return` de guarda: los tests exigen `201` en la petición, así que no pueden
pasar en vacío.

---

## Lo que este port **no** arregla, y hay que decirlo

**Sigue sin haber modelo de autenticación de comercios.** El token es de un solo uso y
caduca, pero **quien lo tenga puede canjearlo**. Como el QR se lo devolvemos al agente que
pidió el efectivo, ese agente podría canjearlo él mismo sin entregar nada.

Lo que se gana frente a antes no es poco:

- el preimage ya no viaja en una query string que acaba en historiales, capturas y logs;
- el canje es **irrepetible**, así que un QR filtrado no vale dos veces;
- hay un punto único donde exigir autenticación cuando exista, en vez de un secreto
  disperso por toda la respuesta.

Lo que falta es exactamente lo que ustedes ya tienen abierto como **WAVE5 Issue 8 —
"modelo de roles del QR"**, que sus propias notas dicen que hay que *"decidir y cerrar antes
de implementar"*. Aquí pasa lo mismo: hasta que el comercio pueda demostrar que es él, el
canje es del portador.

**No lo cierro yo porque es una decisión de producto, no de migración.**

## Y otro que va en el mismo saco

`cashRequests` y los tokens viven en un `Map` en memoria. Un reinicio pierde las peticiones
de efectivo en curso — el mismo problema que ya se corrigió en el `swapStore`. No se tocó
aquí para no mezclar dos cambios en la misma revisión.
