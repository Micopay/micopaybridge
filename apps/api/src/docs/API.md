# MicoPay Protocol API

API REST para agentes AI que da acceso a efectivo físico en México.

## Base URL

```
http://localhost:3000
```

## Autenticación

Esta API usa **x402 Payment Protocol** - cada request debe incluir un header `X-PAYMENT` con una transacción XDR de Stellar USDC.

### Header X-PAYMENT

```
X-PAYMENT: <firma_xdr_base64>
```

Si no incluyes el header, recibirás un `402 Payment Required` con las instrucciones de pago.

## Endpoints

### Health

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servicio |
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe |

### Bazaar (Intent Layer)

| Método | Ruta | Precio | Descripción |
|--------|------|--------|-------------|
| POST | `/api/v1/bazaar/intent` | $0.005 | Broadcast intent |
| GET | `/api/v1/bazaar/feed` | $0.001 | Feed de intents |
| GET | `/api/v1/bazaar/stats` | Gratis | Estadísticas |
| POST | `/api/v1/bazaar/quote` | $0.002 | Enviar quote |
| POST | `/api/v1/bazaar/accept` | $0.005 | Aceptar deal |
| GET | `/api/v1/bazaar/reputation/:addr` | Gratis | Reputación agent |

#### POST /api/v1/bazaar/accept

`secret_hash` es **obligatorio**. El servidor no genera preimagenes.

En un protocolo no custodial la preimagen la genera el iniciador y se la queda:
es la unica llave que abre el escrow. El servidor solo debe ver
`sha256(preimagen)`.

| Campo | Tipo | Obligatorio | Formato |
|-------|------|-------------|---------|
| `intent_id` | string | si | no vacio |
| `secret_hash` | string | **si** | 64 caracteres hexadecimales en minuscula |
| `quote_id` | string | no | |
| `amount_usdc` | number | no | mayor que cero |

Un `secret_hash` ausente o mal formado (largo incorrecto, caracteres no
hexadecimales, mayusculas) devuelve **400** y no bloquea nada.

```bash
# La preimagen se genera del lado del cliente y NO se envia
PREIMAGE=$(openssl rand -hex 32)
SECRET_HASH=$(printf '%s' "$PREIMAGE" | xxd -r -p | openssl dgst -sha256 -hex | awk '{print $2}')
# Guardala: sin ella los fondos no se pueden liberar

curl -H "X-PAYMENT: mock:GTEST123:0.005" \
  -H "Content-Type: application/json" \
  -d "{\"intent_id\":\"int-001\",\"secret_hash\":\"$SECRET_HASH\"}" \
  http://localhost:3000/api/v1/bazaar/accept
```

Si el lock on-chain falla, la respuesta es **502** y el intent queda sin
modificar: no se bloquearon fondos y no cambia ningun contador de historial.

Si el lock se confirma, el pagador que acepto el intent incrementa
`intents_accepted` en 1. Este contador representa una aceptacion real y se
mantiene separado de `swaps_completed`: aceptar solo establece el primer lock,
no demuestra settlement. Por lo tanto `swaps_completed` y `volume_usdc` no
cambian en este endpoint.

La respuesta exitosa incluye `acceptance_recorded: true`,
`acceptance_counter: "intents_accepted"` y mantiene
`reputation_update: "deferred_until_settlement"` hasta que exista una ruta de
settlement que pueda acreditar a ambos participantes.

#### GET /api/v1/bazaar/reputation/:addr

`agent_reputation.intents_accepted` informa cuantas aceptaciones con lock
confirmado ha realizado ese agente. Es una metrica de actividad distinta de
`swaps_completed` y no participa en el tier ni en `completion_rate`.

### Cash (P2P Exchange)

| Método | Ruta | Precio | Descripción |
|--------|------|--------|-------------|
| GET | `/api/v1/cash/agents` | $0.001 | Lista de merchants |
| POST | `/api/v1/cash/request` | $0.01 | Request cash |

### DeFi

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/defi/cetes/rate` | Tasas CETES |
| POST | `/defi/cetes/buy` | Comprar CETES |
| POST | `/defi/cetes/sell` | Vender CETES |
| GET | `/defi/blend/pools` | pools de Blend |

### Servicios

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/services` | Catálogo de servicios |

## Ejemplos

### cURL

```bash
# Health check
curl http://localhost:3000/health

# Con mock payment
curl -H "X-PAYMENT: mock:GTEST123:0.001" \
  http://localhost:3000/api/v1/cash/agents

# Con payment real (XDR)
curl -H "X-PAYMENT: AAAA..." \
  -H "Content-Type: application/json" \
  -d '{"amount":"500","sourceAsset":"USDC"}' \
  http://localhost:3000/defi/cetes/buy
```

### JavaScript

```javascript
const response = await fetch('http://localhost:3000/health');
const data = await response.json();
console.log(data.status); // "ok"
```

## Códigos de Error

| Código | Descripción |
|--------|-------------|
| 200 | OK |
| 400 | Bad Request |
| 402 | Payment Required |
| 404 | Not Found |
| 500 | Internal Server Error |

## Rate Limits

- 100 requests/minuto por IP
- 1000 requests/minuto con API key

## Redes Soportadas

- Stellar Testnet
- Stellar Mainnet (production)

## Contratos Desplegados

| Red | Contrato | ID |
|------|----------|-----|
| Testnet | MicopayEscrow | CBQINHLR3M7NZAPQY7EJ3TWOE22R57LMFDVEMOK3C3X7ZIBFWHVQQP3A |

## Contacto

- GitHub: https://github.com/micopay/micopay-protocol
- Docs: https://docs.micopay.xyz
