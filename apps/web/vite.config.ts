import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // La consola se publica en micopay.com.mx/bridge/, no en la raíz: el ápex lo
  // sirve la landing. Sin esto, vite emite rutas absolutas (/assets/…) que en
  // producción caen fuera del prefijo y devuelven el HTML de la landing en vez
  // del bundle. Configurable por si se monta en otra ruta o en un subdominio,
  // donde valdría '/'.
  base: process.env.VITE_BASE ?? '/bridge/',
  build: {
    // La salida se anida bajo el mismo prefijo que `base`. Los assets estáticos
    // de Cloudflare resuelven por ruta de URL: /bridge/assets/x.js busca
    // dist/bridge/assets/x.js. Sin anidar, todo el bundle daría 404 aunque el
    // HTML se sirviera bien.
    outDir: process.env.VITE_OUT_DIR ?? 'dist/bridge',
    emptyOutDir: true,
  },
  server: {
    port: 5185,
    strictPort: false,
  },
})
