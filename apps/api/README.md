# `@micopay/api`

API del protocolo x402 de MicoPay Bridge: bazaar de intents entre agentes,
planificación y ejecución de swaps atómicos Stellar ↔ XRPL, y credenciales ZK.

## Configuración

Toda la configuración va por variables de entorno. La lista completa —las 59
que lee `src/`, con qué hace cada una y si es obligatoria— está en
**[`.env.example`](.env.example)**.

```bash
cp apps/api/.env.example apps/api/.env
# edita apps/api/.env con tus valores de testnet
```

Tres cosas que conviene saber antes de tocarlo:

- **`src/config.ts` lee el `.env` a mano**, sin `dotenv`, y **solo cuando
  `NODE_ENV != production`**. En producción las variables se inyectan por el
  entorno; el archivo se ignora.
- **El entorno gana.** Una variable ya definida en el proceso no se sobrescribe
  con la del archivo.
- **Casi todo tiene valor por defecto**, así que la API arranca sin configurar
  nada — pero degradada y en silencio: sin `DATABASE_URL` alcanzable el bazaar
  y la protección de replay de x402 caen a memoria, y sin las claves de firma
  las rutas de swap responden pero no pueden mover fondos. Las marcadas
  `REQUERIDO` en `.env.example` son las que hacen falta para que un camino
  concreto funcione de verdad.

Las variables marcadas **`[SECRETO]`** son claves privadas y tokens: firman o
mueven fondos. `.env` está en `.gitignore` (`.env.example` está exceptuado
explícitamente, para poder versionarlo). Nunca pongas un valor real en
`.env.example`.

## Arrancar

```bash
npm install                       # desde la raíz del repo
npm run dev -w @micopay/api       # tsx watch, recarga en caliente
```

Comprobar que responde:

```bash
curl localhost:3000/health/live    # el proceso está vivo
curl localhost:3000/health/ready   # además, las dependencias contestan
```

## Tests

```bash
npm test -w @micopay/api               # suite offline, sin red ni base de datos
npm run typecheck -w @micopay/api      # tsc --noEmit
npm run test:concurrency -w @micopay/api
```

`npm run test:live` y `npm run test:recovery` sí salen a la testnet real y
necesitan identidades fondeadas, por eso no van en CI.

> En un clon limpio `typecheck` falla con `Cannot find module '@micopay/types'`
> hasta que se construyen los paquetes del workspace:
> `npx turbo build --filter=@micopay/types --filter=@micopay/sdk`.
