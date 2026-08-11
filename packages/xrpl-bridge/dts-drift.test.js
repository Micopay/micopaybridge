// Los .d.ts de este paquete están escritos a mano: describen módulos CommonJS
// que nadie compila desde TypeScript. Sin esta prueba pueden mentir y
// `tsc --noEmit` pasa igual — el gate de tipos sale verde y el consumidor
// revienta en runtime con "is not a function".
//
// Se comprueba en las dos direcciones:
//   - lo que el .d.ts declara existe de verdad en el .js
//   - lo que el .js exporta está declarado (si no, TypeScript no lo ve)

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const MODULOS = ["bridge-translate", "relay"];

let fallos = 0;
let comprobados = 0;

for (const modulo of MODULOS) {
  const mod = require(`./${modulo}`);
  const dts = fs.readFileSync(path.join(__dirname, `${modulo}.d.ts`), "utf8");

  const declarados = new Set(
    [...dts.matchAll(/^export declare (?:function|const|class)\s+(\w+)/gm)].map((m) => m[1])
  );
  const exportados = new Set(Object.keys(mod));

  for (const nombre of declarados) {
    if (!exportados.has(nombre)) {
      console.error(`  ✗ ${modulo}.d.ts declara "${nombre}" y ${modulo}.js NO lo exporta`);
      fallos++;
    }
  }

  for (const nombre of exportados) {
    if (!declarados.has(nombre)) {
      console.error(`  ✗ ${modulo}.js exporta "${nombre}" y ${modulo}.d.ts NO lo declara`);
      fallos++;
    }
  }

  // Lo declarado como función o clase tiene que serlo de verdad.
  for (const m of dts.matchAll(/^export declare (function|class)\s+(\w+)/gm)) {
    const [, tipo, nombre] = m;
    if (exportados.has(nombre) && typeof mod[nombre] !== "function") {
      console.error(`  ✗ ${modulo}.d.ts declara "${nombre}" como ${tipo} y es ${typeof mod[nombre]}`);
      fallos++;
    }
  }

  comprobados += declarados.size;
  console.log(`ok - ${modulo}: ${declarados.size} exports coinciden en ambos sentidos`);
}

assert.strictEqual(fallos, 0, `${fallos} discrepancia(s) entre los .d.ts y sus .js`);
console.log(`\n${comprobados} exports comprobados en ${MODULOS.length} módulos`);
