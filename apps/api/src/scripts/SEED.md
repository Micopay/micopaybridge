# Database Seeder

Script para poblar la base de datos con datos iniciales de prueba.

## Uso

```bash
# Con PostgreSQL corriendo (docker)
docker-compose up -d postgres

# Poblar la base de datos
cd apps/api
npm run seed

# O directamente
npx tsx src/scripts/seed.ts
```

## Datos que crea

| Tabla | Registros | Descripción |
|-------|-----------|--------------|
| `merchants` | 5 | Agentes P2P en CDMX |
| `bazaar_intents` | 2 | Intents de ejemplo |
| `agent_history` | 2 | Historial de agentes |
| `x402_payments` | 3 | Pagos x402 de ejemplo |
| `swap_history` | 4 | Historial de swaps |

## Estructura de Merchants

| ID | Nombre | Tipo | Tier | Trades |
|----|--------|------|------|--------|
| MERCH001 | Farmacia Guadalupe | farmacia | maestro | 312 |
| MERCH002 | Tienda Don Pepe | tienda | experto | 156 |
| MERCH003 | Papelería La Central | papeleria | activo | 45 |
| MERCH004 | Consultorio Dr. Martínez | consultorio | espora | 12 |
| MERCH005 | Abarrotes El Güero | abarrotes | activo | 78 |

## Scripts Disponibles

```bash
npm run seed      # Poblar base de datos
npm run db:reset  # Limpiar todas las tablas
npm run db:setup  # Alias para seed
```

## Reiniciar Base de Datos

```bash
# Detener servicios
docker-compose down -v

# Iniciar de nuevo
docker-compose up -d postgres

# Poblar datos
npm run seed
```
