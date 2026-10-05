# Bot de Telegram (archivado)

Código **preservado, no integrado**. Llegó desde `micopay-protocol` (`apps/telegram-bot`, commit `0819496`) en el paso M2 de su limpieza. Está fuera de los workspaces de npm y el CI no lo compila ni lo prueba.

Consulta la API de efectivo de agentes (`/api/v1/cash/agents`).

Antes de ejecutarlo hay que ajustar dos cosas heredadas:
- **Arranque:** `package.json` ejecuta `dist/index.js`, pero con `rootDir: "."` e `include: ["src/**/*.ts"]` el compilado queda en `dist/src/index.js`.
- **Configuración:** `src/index.ts` busca `.env` junto al archivo que se ejecuta, mientras que `.env.example` está en la raíz del paquete.
