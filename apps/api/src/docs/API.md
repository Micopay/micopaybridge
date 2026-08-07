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
