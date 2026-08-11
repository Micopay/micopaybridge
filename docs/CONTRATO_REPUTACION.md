# Contrato del endpoint interno de reputación

**Para:** quien mantiene `micopay/backend` en
[`micopay-protocol`](https://github.com/ericmt-98/micopay-protocol).
**Por qué:** cerrar la frontera del §M3 del plan de split con la opción (b).

---

## El problema, en dos frases

`micopaybridge` sirve reputación de comercios a agentes IA detrás de x402, pero esos datos
son del producto retail y viven en la base del backend móvil. Hoy los lee directamente de
la tabla `merchants`, así que **una migración vuestra rompe una ruta de pago nuestra sin
que nadie se entere hasta que un agente recibe un 500**.

Con este endpoint el acoplamiento pasa de "misma tabla" a "mismo contrato": versionado,
explícito, y roto en voz alta si cambia.

## Lo que hace falta

Dos rutas de solo lectura bajo `/internal/v1/`, no expuestas a internet — red interna o
detrás de un `Bearer` compartido. **No hay escrituras**: `micopaybridge` nunca modifica
datos de comercios.

### `GET /internal/v1/merchants/:stellarAddress/reputation`

`200` con el cuerpo de abajo, o `404` si esa dirección no es un comercio **verificado**.

```json
{
  "stellar_address": "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG",
  "display_name": "Abarrotes Doña Mari",
  "location": "Av. Insurgentes Sur 1234, CDMX",
  "trades_completed": 47,
  "completion_rate": 0.9362,
  "avg_time_minutes": 12,
  "total_volume_usdc": 8412.5,
  "verified_at": "2026-05-14T18:22:00.000Z"
}
```

### `GET /internal/v1/merchants/reputation`

Todos los verificados. `{ "merchants": [ …lo mismo… ] }`.

## Reglas que importan

- **`completion_rate` es un número entre 0 y 1**, no un porcentaje. Ojo con `pg`: devuelve
  los `NUMERIC`/`DECIMAL` como **string** para no perder precisión, así que hay que
  convertirlo antes de serializar. Si llega `"0.9362"` en vez de `0.9362`, los tiers salen
  mal y nadie lo nota — el JSON parece correcto.
- **`404` significa "no es un comercio verificado"**, no "no lo encuentro ahora mismo". Si
  la base está caída, devolved `503`. Nosotros traducimos `404` a *"este comercio no es de
  fiar"*, que es una respuesta muy distinta a *"no lo sé"*, y un agente actúa sobre ella.
- **Solo verificados.** `verification_status = 'verified'`. Lo que esté `pending` o
  `paused` no debe salir.
- **La versión va en la ruta.** Si cambiáis la forma, publicad `/internal/v2/…` y avisad;
  no cambiéis `v1` en sitio.
- Sin datos personales del dueño: nombre público del comercio y ubicación, nada más.

## Cómo lo consumimos

`apps/api/src/lib/reputation-source.ts`. Ya está escrito el cliente entero. Activarlo es
una variable de entorno:

```bash
MICOPAY_BACKEND_URL=http://micopay-backend.internal:3002
MICOPAY_BACKEND_TOKEN=<compartido>        # opcional
MICOPAY_BACKEND_TIMEOUT_MS=4000           # opcional
```

Sin `MICOPAY_BACKEND_URL` seguimos leyendo vuestra base directamente y lo avisamos en el
log de arranque. **Ese es el estado actual y el que queremos dejar atrás.**

## Lo que NO os pedimos

- Calcular tiers. Los tiers (`maestro`, `experto`, `activo`, `espora`) son nuestros y
  cambian con criterios de agentes, no de retail. Mandad los números crudos.
- Nada de x402, ZK ni swaps. Ese lado es enteramente nuestro.
- Latencia baja: cacheamos y toleramos 4 s.
