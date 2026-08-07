import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // El default de vitest son 5000 ms. Cuatro tests llevaban ~2000 ms de
    // coste fijo, así que el margen era 2,5x — suficiente en local y no
    // cuando turbo corre cinco workspaces a la vez. Con 20 s un test lento
    // no tumba la suite, y uno colgado de verdad sigue fallando.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      // El swapStore persiste en disco. En tests se desactiva: no queremos que
      // una corrida deje un swap-store.json ni que herede el de la anterior.
      SWAP_STORE_PATH: "",
      // Los sondeos de confirmación esperan ledgers reales. En test no hay
      // ledger que esperar: eran ~8 s de reloj por corrida sin comprobar nada.
      SOROBAN_POLL_INTERVAL_MS: "0",
      // Sin base de datos levantada, no reintentar la conexión en cada pago.
      X402_DB_RETRY_MS: "600000",
      PG_CONNECT_TIMEOUT_MS: "1000",
    },
  },
});
