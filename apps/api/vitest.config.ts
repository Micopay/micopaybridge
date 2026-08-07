import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // El swapStore persiste en disco. En tests se desactiva: no queremos que
      // una corrida deje un swap-store.json ni que herede el de la anterior.
      SWAP_STORE_PATH: "",
    },
  },
});
