# La capa de datos de `apps/api` — qué estaba roto y qué se hizo

**Propuesta, no hecho consumado.** Todo esto viene de `micopay-protocol` tal cual; nada lo
rompió la migración. Se arregla aquí porque entregar el hallazgo sin la solución deja al
equipo con el mismo trabajo y menos contexto. Si prefieren otra salida, el punto de partida
está escrito y se revierte sin arrastrar nada más.

---

## Cómo se descubrió

Los 101 tests de `apps/api` corren **con la base caída** — de ahí el `ECONNREFUSED` en cada
corrida. Nadie había levantado Postgres contra este código. Al hacerlo, no arrancaba de
ninguna de las tres formas posibles:

| Orden | Resultado |
|---|---|
| Seed solo, base vacía | ❌ `value too long for type character varying(56)` |
| Migración → seed | ❌ `column "lat" does not exist` |
| Seed → rutas | ❌ `reputation.ts` pide `display_name`, que el seed no crea |

**No existía ninguna combinación en la que la capa de datos funcionara.**

---

## Causa 1 — tres definiciones de `merchants`, ninguna con dueño

```
001_initial_schema.sql   user_id, display_name, latitude,  longitude, verification_status,
                         stellar_address, type, available_mxn, tier, ...
db/merchants.ts:64       user_id, display_name, verification_status   (sin stellar_address)
seed.ts:342              stellar_address, name, lat, lng, online, verified
```

Las tres usaban `CREATE TABLE IF NOT EXISTS`, así que **ganaba la primera que corriera** y
el resto del código quedaba roto en silencio. Y la de la migración —que es la reconciliación
de las otras dos, tiene columnas de ambas— **nunca corría**: `runMigrations()` existía y no
lo llamaba nadie, ni aquí ni en el repo de origen.

**Qué se hizo:**
- `runMigrations()` se llama al arrancar (`index.ts`). No tumba el arranque si la base no
  está: esta API funciona sin ella, pero el fallo se ve en el log.
- El seed deja de declarar su propia tabla y escribe en la de la migración.
- `db/merchants.ts` se borra. Ya no lo importaba nadie desde que la frontera del §M3 pasó a
  `lib/reputation-source.ts`, y mantener una tercera definición era garantizar que el
  problema volviera.

**Queda como decisión del equipo:** la migración es ahora la única fuente de verdad del
esquema. Si prefieren que lo sea otra cosa, hay que decirlo explícitamente — el fallo no fue
elegir mal, fue que no había elección escrita en ningún sitio.

## Causa 2 — ninguna dirección Stellar del seed era válida

No es que tres tuvieran mala longitud. **Las siete fallaban el checksum**, comprobado con
`StrKey.isValidEd25519PublicKey`:

```
59  GDEMOREVIEWER111…      59  GDEMO1MERCHANT11…      57  GDAHK7EEG2WWHVKD…
56  GCEZWKCA5VLDNRLN…      56  GCF3CJXADZKIODEG…      56  GDTEZWGQB7V2CLS6…
56  GAHK7EEG2WWHVKDN…
```

Las de 56 caracteres pasaban la validación de `reputation.ts` (que solo mide longitud) pero
`new Asset(code, issuer)` las rechaza, y ninguna puede recibir un pago.

**Qué se hizo:** sustituidas por direcciones válidas y **deterministas**, derivadas de
semillas fijas para que cualquiera pueda regenerarlas:

```js
Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey()   // n = 1..7
```

| n | Quién | Dirección |
|---|---|---|
| 1 | demo_reviewer | `GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR` |
| 2 | demo_merchant | `GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U` |
| 3 | Farmacia Guadalupe | `GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG` |
| 4 | Tienda Don Pepe | `GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP` |
| 5 | Papelería La Central | `GBXHUHG5FGYLPD6RHL2MKWMP572O6KUXCZXDZJXS4T57ZTMAKBN7DWXN` |
| 6 | Consultorio Dr. Martínez | `GCFIOX77D2ZYIUKXPLGVV7XEAVCWK2G5PSE6BEEGHICVPPD26SPRPPVB` |
| 7 | Abarrotes El Güero | `GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57` |

38 reemplazos en 10 archivos, incluida la consola (`ReputationPanel.tsx` traía la de 57
caracteres hardcodeada) y `demo.ts`.

## Causa 3 — la reputación buscaba la dirección donde el seed no la pone

El esquema canónico guarda la dirección en **dos sitios**: `merchants.stellar_address`
(comercio dado de alta directo) y `users.stellar_address` (comercio ligado a una cuenta). La
consulta miraba solo la segunda con un `JOIN`, así que devolvía vacío para todo lo que
siembra el seed.

**Qué se hizo:** `LEFT JOIN` y `WHERE (m.stellar_address = $1 OR u.stellar_address = $1)`.

---

## Verificación

Postgres 16 en contenedor, base vacía:

```
1. migraciones   ✅ 001_initial_schema.sql successful
2. seed          ✅ 5 merchants · 3 payments · 4 swaps
3. API arriba    ✅ migraciones al arrancar
```

Las ocho rutas responden 200: `/reputation/:address`, `/merchants`, `/bazaar/stats`,
`/cash/agents`, `/fund/stats`, `/services`, `/health`.

Y lo que importa — **la reputación distingue por dirección**, que era el bug de fondo:

```
GDWUSKGGFDI4…  Farmacia Guadalupe    | tier maestro | trades 312
GDFJHLAXAUMH…  Tienda Don Pepe       | tier experto | trades 156
GBXHUHG5FGYL…  Papelería La Central  | tier experto | trades  45
GCFIRY65OQE7…  (no es comercio)      → 404
```

Antes, cualquier dirección válida devolvía siempre el mismo comercio.

---

## Lo que NO se tocó, a propósito

**El emisor de MXNe es una dirección inválida.**
`GBZXN7PIRZGNMHGA7MUUUF4GWMTISGNQ5E72TFL6GDWPE6K4RCAVOALV` falla el checksum:
`new Asset("MXNe", …)` lanza `Issuer is invalid`. Está en `swaps.ts:26` — y también en
**`micopay/contracts/TESTNET.md` y en los `.env` del equipo**, así que el original está en
el doc canónico de ustedes, no aquí.

Hoy el efecto es silencioso: `assetParams()` solo la mete en un query string de Horizon, que
no devuelve libro de órdenes y cae a `FALLBACK_RATES`. Pero cualquier código que construya
un `Asset` con ella revienta.

**No la corregí porque no sé cuál es la buena, y adivinarla sería peor que dejarla.**
