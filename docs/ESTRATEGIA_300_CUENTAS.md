# Estrategia — 300 cuentas activas (Make Waves)

Borrador para discutir con el team. No es código, es la forma de conseguir
las 300 direcciones distintas sin pisar la cláusula anti-sybil del T&C
(§7): *"Wash trading, sybil attacks, self-dealing, scripted transactions...
strictly prohibited... disqualified and any provisional prize forfeited."*

## La regla, en una frase

**Cada una de las 300 firma con su propia wallet.** El backend puede armar
la transacción entera — monto, condición, el `SourceTag` — pero el botón
de firmar lo aprieta la persona, no un script del team. Eso es lo único
que separa "300 usuarios reales" de "sybil attack".

## Qué transacción usar

Tres opciones, de más simple a más fiel al producto:

| Opción | Qué firma el usuario | Riesgo |
|---|---|---|
| (a) Payment simple | Un pago cualquiera con el source tag | Barato y rápido, pero es el patrón más fácil de leer como "inorgánico" — el T&C dice que el jurado puede *descontar* tx que "reasonably believed to be inorganic" aunque técnicamente sí cuenten |
| (b) EscrowCreate real (recomendada) | Bloquea un monto pequeño propio (ej. 1-2 XRP) contra el contrato del puente, con el source tag | Usa la primitiva real del hackathon (`EscrowCreate`), no es un gesto vacío — más defendible ante revisión manual |
| (c) Swap atómico completo | El flujo de dos piernas real (XRPL↔Soroban) | El más fiel al producto, pero necesita contraparte para cada uno de los 300 — no escala en 3 días sin automatizar la contraparte, y automatizar la contraparte del team sí es zona gris (self-dealing en una pierna) |

Recomiendo (b): real, barato, usa la primitiva del reto, y no depende de
tener 300 contrapartes humanas simultáneas. Decisión final del team — yo
no puedo elegir el trade-off costo/tiempo por ustedes.

## Flujo mínimo por usuario (<1 minuto, sin fricción)

1. Usuario abre un link/QR (web, sin login — como pide `UX_MANIFESTO` para
   MicoPay en general)
2. El backend arma el payload de `EscrowCreate` con `SourceTag: 2607170001`
   ya puesto — el usuario no toca esa parte
3. El usuario conecta su wallet (Xumm/Crossmark vía deep link o extensión)
   y firma. Un clic.
4. Confirmación en pantalla con el link al explorer (`livenet.xrpl.org`) —
   prueba social, la persona ve que de verdad pasó algo on-chain

No hace falta cuenta, contraseña ni KYC del usuario — solo la wallet.

## Qué falta construir (no está hecho hoy)

- Endpoint que arme el `EscrowCreate` payload (existe la lógica en
  `apps/api/src/lib/xrpl-leg.ts`, pero hoy firma con la llave de la
  plataforma — hay que separar "armar la tx" de "firmarla", y devolver el
  payload sin firmar para que la wallet del usuario lo firme)
- Página pública mínima que reciba el payload y lo mande a Xumm/Crossmark
  (no existe — la consola actual es solo demo de agentes, no tiene este
  flujo de usuario final)
- Definir el monto y qué pasa con los fondos bloqueados (¿se le devuelven
  al usuario tras el timeout? ¿el team los recibe como "prueba"? — esto sí
  es decisión de producto/negocio, no técnica)

## Riesgo de "inorgánico" aunque se cumpla la letra

El T&C separa dos cosas: descalificación (sybil/scripted, prohibido tajante)
y descuento discrecional del jurado ("we reserve the right to manually
review... and to discount transactions reasonably believed to be inorganic").
300 transacciones idénticas, del mismo monto, en la misma hora, calzan con
"inorgánico" aunque cada una la haya firmado una persona distinta. Para
que se vea real:

- Variar el monto un poco por usuario (o dejar que cada quien elija)
- Repartir en el tiempo — no lanzar todo en una sola campaña de una hora
- Que la distribución (a quién le llega el link) sea gente real con motivo
  real de probarlo, no una lista comprada — esto es trabajo de comunidad/
  outreach del team, no algo que yo pueda ejecutar

## Cómo llegar a 300 personas reales

Fuera de mi alcance decidirlo — es la parte de comunidad/canales del team
(Discord de XRPL Commons, red de comercios de MicoPay en México, redes del
equipo). Lo anoto aquí porque es el paso que más tiempo real va a tomar,
más que cualquier cosa de código.
