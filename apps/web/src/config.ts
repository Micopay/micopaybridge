/**
 * Configuración de entorno de la consola, en un solo sitio.
 *
 * Estaba duplicada entre `App.tsx` y `hooks/useDemoStatus.ts`, las dos con el
 * mismo `?? "http://localhost:3000"`. Publicada en micopay.com.mx/bridge eso
 * significaba que cada llamada iba al puerto 3000 de la máquina de quien
 * abriera la página, y encima bloqueada por contenido mixto (http desde
 * https): la consola pintaba entera y nada funcionaba, sin decir por qué.
 *
 * En build de producción no hay valor por defecto a propósito. Si falta
 * `VITE_API_URL`, `API_URL` es null y la consola lo dice en pantalla en vez de
 * fallar contra una dirección que no es de nadie.
 *
 * Nota sobre por qué se lee `import.meta.env.X` directamente y no a través de
 * una variable intermedia: vite sustituye esas expresiones por literales en
 * tiempo de build, y solo así puede eliminar la rama de desarrollo. Con un
 * alias (`const ENV = import.meta.env; ENV.DEV`) el comportamiento es el mismo
 * pero las URLs de localhost se quedan dentro del bundle publicado.
 */

/** true en `vite dev`, false en cualquier build. */
export const IS_DEV: boolean = import.meta.env.DEV;

/**
 * URL de la API del bridge (`apps/api`). En desarrollo se asume el puerto
 * local donde la levanta `npm run dev`.
 */
export const API_URL: string | null = import.meta.env.DEV
  ? import.meta.env.VITE_API_URL ?? "http://localhost:3000"
  : import.meta.env.VITE_API_URL ?? null;

/** Enlace opcional a la app móvil. Sin valor, el enlace no se muestra. */
export const APP_URL: string | null = import.meta.env.DEV
  ? import.meta.env.VITE_APP_URL ?? "http://localhost:5181"
  : import.meta.env.VITE_APP_URL ?? null;
