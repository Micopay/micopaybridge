# Scripts del protocolo

Llegaron desde `micopay-protocol` (commit `0819496`) en el paso M2 de su limpieza. Se ejecutan desde la raíz del repositorio y **requieren preparación**:

| Script | Requisitos |
|---|---|
| `setup-demo-agent.mjs` | `apps/api/.env` preparado (lo lee sin alternativa si falta) |
| `deploy-contracts.sh` | `stellar` CLI y `PLATFORM_SECRET_KEY`; compila solo `atomic-swap` y `micopay-escrow` |
| `demo.sh` | API corriendo; `X402_MOCK_MODE=true` fuera de producción para los pagos simulados; credenciales de los servicios externos |
| `demo-atomic-swap.mjs` | **Demo histórica** con cuentas y contratos fijos; ver la advertencia del archivo antes de ejecutarlo |
| `prove-mock-stellar.js` | `apps/api/.env`. Simula la emisión de un JWT; no demuestra una vulnerabilidad del backend actual |
