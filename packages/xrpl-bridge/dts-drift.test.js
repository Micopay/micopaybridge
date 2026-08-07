// bridge-translate.d.ts está escrito a mano: describe un módulo CommonJS que
// nadie compila desde TypeScript. Sin esta prueba, el .d.ts puede mentir y
// `tsc --noEmit` pasa igual — el gate de tipos sale verde y el consumidor
// revienta en runtime con "is not a function".
//
// Se comprueba en las dos direcciones:
//   - lo que el .d.ts declara existe de verdad en el .js
//   - lo que el .js exporta está declarado (si no, TypeScript no lo ve)

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const bt = require("./bridge-translate");

const dts = fs.readFileSync(path.join(__dirname, "bridge-translate.d.ts"), "utf8");

const declarados = new Set(
  [...dts.matchAll(/^export declare (?:function|const)\s+(\w+)/gm)].map((m) => m[1])
);
const exportados = new Set(Object.keys(bt));

let fallos = 0;

for (const nombre of declarados) {
  if (!exportados.has(nombre)) {
    console.error(`  ✗ el .d.ts declara "${nombre}" y bridge-translate.js NO lo exporta`);
    fallos++;
  }
}

for (const nombre of exportados) {
  if (!declarados.has(nombre)) {
    console.error(`  ✗ bridge-translate.js exporta "${nombre}" y el .d.ts NO lo declara`);
    fallos++;
  }
}

// Los tipos declarados como `function` tienen que ser funciones de verdad.
for (const m of dts.matchAll(/^export declare function\s+(\w+)/gm)) {
  const nombre = m[1];
  if (exportados.has(nombre) && typeof bt[nombre] !== "function") {
    console.error(`  ✗ el .d.ts declara "${nombre}" como función y es ${typeof bt[nombre]}`);
    fallos++;
  }
}

assert.strictEqual(
  fallos,
  0,
  `${fallos} discrepancia(s) entre bridge-translate.d.ts y bridge-translate.js`
);

console.log(`ok - .d.ts y .js coinciden (${declarados.size} exports comprobados en ambos sentidos)`);
