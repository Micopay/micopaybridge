# Propuesta de valor — ZK Agent Credentials

> **Documento de posicionamiento.** Por qué esto vale, por qué escala a muchos negocios,
> y dónde NO forzarlo. Complemento de [`README.md`](./README.md) (índice),
> [`HACKATHON.md`](./HACKATHON.md) (pitch) y [`AUDIT.md`](./AUDIT.md) (estado real).

---

## El valor en una frase

> **Dejar que un agente (o persona) demuestre que tiene derecho a consumir un recurso
> —y cuánto le queda— sin revelar quién es ni permitir que nadie ligue su actividad,
> con esa prueba verificada on-chain en Soroban.**

## La tesis de Stellar: probar que algo es verdad sin revelar nada

Stellar apuesta por *"abierto por defecto, privado cuando se necesita"* y añadió las funciones
BN254 a Soroban para que los contratos verifiquen pruebas ZK on-chain. Lo que un juez de Stellar
quiere ver no es "otra app de pagos", sino **una afirmación financiera real probada on-chain sin
filtrar lo sensible**. ZK solo gana su lugar donde coexisten **algo verdadero que probar** y **algo
que vale la pena ocultar**; si no hay qué ocultar, una firma normal basta.

**La afirmación que probamos en Soroban:**

> *"Tengo derecho a consumir este recurso —una credencial válida, pagada y sin usar— y no la he
> gastado antes."*

**Lo que queda oculto (esto es el valor):** quién soy · cuál credencial es · qué pago la financió ·
el vínculo entre mis distintos consumos.

## Las tres piezas: x402 + credencial + ZK (ninguna reemplaza a otra)

No son tres puertas alternativas ni se apilan en la misma llamada: forman **una tubería** donde cada
parte hace un trabajo distinto, y **ZK solo actúa donde hay algo que esconder**:

```
   PAGAR (x402)  ── público ──►  emite N credenciales (hojas en el árbol, raíz on-chain)
                                          │
                                          ▼
   CONSUMIR (credencial + ZK) ── privado ──►  prueba "tengo una credencial válida y sin usar"
                                              + nullifier (un solo uso)  →  recurso servido
```

- **x402** = cómo se paga / se compran las credenciales. **Es público y está bien que lo sea** —
  un pago no tiene nada que ocultar; ZK sobre el pago sería decoración.
- **credencial** = el secreto que te llevaste de ese pago (el *testigo* de la prueba).
- **ZK** = en el momento de consumir, prueba que tu secreto está en el conjunto pagado **sin decir
  cuál ni quién**, y revela solo un *nullifier* para impedir la reutilización.

**El "wow" para Stellar — la desvinculación pago↔consumo:** pagaste a la vista de todos (x402 en
Stellar), pero consumes en el anonimato, y **nadie —ni siquiera MicoPay— puede unir "quién pagó" con
"quién consumió"** (no se puede ir de `H(secret)` al pago sin el `secret`). Esa desvinculación,
verificada con ZK en Soroban, *es* "abierto por defecto, privado cuando se necesita".

> **Escalones más ambiciosos de la misma tesis:** (1) que el conjunto del árbol *sean los propios
> pagos x402* → probar "soy uno de los que pagaron" sin emisor de confianza; (2) probar **saldo sin
> revelarlo** ("mi crédito ≥ el costo", range proof) → la forma más pura de probar una verdad
> numérica ocultando el número. Ver [`AUDIT.md`](./AUDIT.md) §2.4.

## El insight que lo hace valioso

Normalmente privacidad y control son un trade-off:

- **Anónimo pero no rendible** → spam, abuso, consumo infinito.
- **Rendible pero vigilado** → cada llamada queda registrada y ligada a ti.

El diseño **Merkle (pertenencia) + nullifier (un solo uso)** rompe ese trade-off: se puede
ser **anónimo _y_ tener consumo finito y auditado a la vez**. Nadie sabe quién eres, pero
cada credencial se gasta una sola vez. Ese es el núcleo del valor.

---

## Por qué escala a muchos negocios (el mecanismo, no la lista)

No escala porque "se pueda aplicar a varios". Escala porque es **un solo motor con un
significado distinto en la hoja**. El circuito es siempre el mismo —*pertenencia + umbral +
nullifier*— y lo único que cambia entre negocios es **qué codifica la hoja** y **qué se
chequea**:

| La hoja significa… | El negocio prueba… |
|---|---|
| créditos de inferencia | "tengo acceso pagado y me quedan ≥ X" |
| pasó KYC / es acreditado | "cumplo el requisito sin decir quién soy" |
| boleto / entrada | "tengo acceso, una sola vez" |
| elegible (airdrop/voto) | "puedo reclamar/votar, sin doble gasto" |

Es exactamente la tesis de `ZkVerifierRegistry`: **un registro de circuitos auditados**.
Registras un circuito una vez; cualquier negocio lo consume vía la misma API + x402. Por eso
`reputation_v1` y "credencial de acceso" son el mismo código: cada negocio nuevo es una hoja
distinta, no un sistema nuevo.

---

## Cuándo encaja de verdad (las 4 condiciones)

El primitivo brilla cuando se cumplen **las cuatro a la vez**:

1. Hay que **gatear o medir** acceso (importa el consumo, no es gratis-para-todos).
2. El consumidor quiere **ocultar identidad o patrón** de uso.
3. Hay que **prevenir abuso/sobreuso** (anti-spam, anti-doble-gasto).
4. **Nadie debe quedarse con la liga** (ni siquiera el emisor puede reconstruir el historial).

Si falta cualquiera de las cuatro, probablemente un token firmado / API key normal basta y
ZK es sobre-ingeniería.

---

## Verticales

### Fits fuertes
- **Inferencia / gateways de API** — el negocio esconde qué modelos y cuánto consume. *(Flagship.)*
- **Finanzas reguladas con compliance** — probar *"estoy KYC'd / soy acreditado / bajo mi límite"*
  sin doxxearte ante el protocolo. **El más grande y el más alineado con Stellar**
  ("privado cuando se necesita" para finanzas reguladas). Mercado enterprise.
- **Data premium / market data** — fondos y traders no quieren exponer su patrón de consumo.
- **Salud / genómica** — probar autorización para consultar sin registrar quién consultó qué.
- **Contenido medido anónimo** — paywalls/periodismo/contenido sensible sin perfil de lectura.
- **Anti-sybil / airdrops / faucets / votación** — elegible una sola vez, sin revelar identidad.

### Stretch (no forzar)
- **B2B SaaS normal** — el negocio *quiere* saber quién es el cliente; la privacidad estorba.
- **Altísimo volumen / bajo valor** — un write on-chain por consumo es caro.
- **Ocultar el _contenido_ (no la identidad)** — eso es FHE/TEE, otro problema.

---

## El matiz del "—y cuánto le queda—" (decisión de diseño)

La frase de valor promete *medición de saldo*, y eso admite dos arquitecturas distintas. Hay
que elegir conscientemente:

1. **Fichas discretas** (lo que casi existe hoy): N credenciales de un solo uso. "Cuánto le
   queda" = cuántas no ha gastado. Simple, casi implementado — pero **el conteo lo lleva el
   cliente** (la no-ligabilidad impide que el emisor las cuente).
2. **Credencial con saldo** (más potente, más trabajo): una credencial con balance + una
   *range proof* — "pruebo que mi saldo ≥ X" y lo actualizo. Permite "cuánto le queda" de
   verdad, pero es un circuito más complejo (no es el `reputation_v1` actual).

> Para el hackathon, **fichas discretas** cuentan la historia. **Saldo privado** es el upgrade
> que lo vuelve producto serio. Ver [`AUDIT.md`](./AUDIT.md) §2.4.

---

## Cómo conecta con MicoPay (por qué aquí y no en cualquier lado)

El valor más defendible **no** es "otro marketplace de pago para agentes" — ahí pierdes contra
Base/Solana, que ya tienen el volumen. El valor es ser **la capa de confianza/acceso privado
que el dinero y los agentes digitales no tienen, anclada en Stellar**, y eventualmente
conectada a **dinero real en LatAm** (el foso de efectivo físico).

- **Stellar no tiene primitivo nativo de credenciales** ni estándar de atestación (no hay
  equivalente a EAS). Lo estás construyendo → es **infraestructura del ecosistema**, no una app.
- **MicoPay es su propio cliente #1**: ZKaaS gatea el acceso a *nuestros* servicios primero; la
  infra que construimos para nosotros se vuelve el producto que vendemos a otros.

---

## Posicionamiento en una línea

> **Estamos construyendo el carril de _acceso privado y rendible_ para la economía de agentes
> —la pieza que permite consumir sin exponerse— y Stellar es donde esa prueba se vuelve
> verificable.**

> ⚠️ El valor se materializa **solo si** se cierra (a) la semántica del nullifier y (b) el
> consumo real de un recurso. Hoy existe el motor; falta el producto. Detalle priorizado en
> [`AUDIT.md`](./AUDIT.md) §7-§8.
