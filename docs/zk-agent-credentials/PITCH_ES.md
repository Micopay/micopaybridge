# La historia (en palabras sencillas) — para presentar

> Versión en español llano para pitch/exposición. El one-pager técnico está en
> [`HACKATHON.md`](./HACKATHON.md); el detalle, en [`SPEC.md`](./SPEC.md).

---

## El problema

Hoy los agentes de IA pagan por usar inteligencia (como Claude) **llamada por llamada**, y
esos pagos se hacen en Base **a la vista de todos**. Cualquiera —tu competencia incluida— puede
ver **qué usa tu agente, cuánto y cuándo**. Tu forma de trabajar queda expuesta. Pagar se volvió,
sin querer, **espiar**.

## La idea

Separamos dos cosas que hoy van juntas: **pagar** y **usar**.

- **Pagar** puede ser público — no pasa nada.
- **Usar** debe ser privado: poder demostrar que *tienes derecho* a usar algo **sin decir quién
  eres**, y sin que nadie pueda **conectar tu pago con tu uso**.

## Cómo funciona (como fichas de casino)

1. El agente **compra fichas** (paga en Base, su mundo de siempre). Público.
2. Para usar la IA, **presenta una ficha** y demuestra que es buena **sin enseñar su nombre**
   (eso es la "prueba ZK").
3. La ficha **se quema** al usarla → vale **una sola vez** → nadie abusa.
4. Recibe su respuesta.

Lo importante: **ni siquiera nosotros podemos saber que "la ficha que se usó" es de "quien la
compró".**

## Quién hace el trabajo pesado

El agente **solo habla por internet** con nosotros (manda un número, manda una prueba). **Nosotros
somos el puente:** cobramos en Base, le pagamos a la API de Base (la inferencia), y **hacemos la
parte mágica en Stellar** (verificar la ficha en privado).

- **El agente** vive en **un solo mundo (Base)**: su billetera de Base + un secreto. Nada en Stellar.
- **MicoPay** vive en **los dos**: billetera en Base (cobrar, pagar APIs, mover dinero) y cuenta en
  Stellar (verificar la prueba). **Absorbemos toda la complejidad** para que el agente no la vea.

## Por qué Stellar

Base tiene el movimiento y el dinero, pero **no tiene** una forma de **probar cosas en privado,
verificada en la cadena**. Stellar sí — fue hecho justo para eso (*"abierto por defecto, privado
cuando se necesita"*). No competimos con Base: **le ponemos la capa de privacidad que le falta.**

> **Base es la puerta. Stellar es la bóveda.**

## Lo que de verdad logramos

Algo que parecía imposible: ser **anónimo y, a la vez, controlado** (cada ficha = un uso).
Normalmente, para evitar abusos tienes que identificar a la gente. Aquí no hace falta.

## La frase para cerrar

> **El agente paga a la vista y usa en el anonimato, sin que nadie pueda unir las dos cosas. Vive
> en Base; la confianza se prueba en Stellar; nosotros somos el puente invisible.**

---

## ¿Esto nos hace custodios? (nota para Q&A)

**No, en el flujo de credenciales/inferencia.** Cobramos por **nuestro propio servicio** y pagamos
las APIs con **nuestro propio dinero** — eso es ser **infraestructura**, no custodio (patrón
AWS/Stripe: que te paguen ≠ custodiar). El agente no nos **deposita** fondos para que se los
guardemos y devolvamos; paga por un servicio y lo recibe.

**Dónde sí aparecería regulación de transmisión de dinero:** al **entregar efectivo (pesos) a un
tercero** (la vertical de cash-out, Fase 2). Eso es lo regulado y va aparte/después.

**Matiz a cuidar:** las credenciales son "prepago". Mientras solo sirvan para **nuestro servicio**
(no se puedan cambiar por efectivo ni transferir a terceros por valor), es prepago tipo SaaS/gift
card, **no custodia**. Si se volvieran canjeables por efectivo, entraríamos en zona gris.
