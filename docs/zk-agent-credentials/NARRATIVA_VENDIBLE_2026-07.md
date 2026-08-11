# Narrativa vendible — ZK Agent Credentials

> **Entregable 3 de la revisión Fable.** Refina [`PITCH_ES.md`](./PITCH_ES.md) y
> [`VALUE_PROP.md`](./VALUE_PROP.md) hacia una narrativa de producto: problema real, cliente,
> por qué Stellar+ZK es la cuña, y un guion de demo de 2–3 min para jueces no técnicos.
> Donde el código contradice el pitch, lo señalo (⚠️) — no asumo docs actualizados.

---

## 1. El problema, en términos de negocio (no de cripto)

Los agentes de IA ya compran servicios solos: inferencia, datos, APIs, pagando por llamada. Ese
mercado (agentic.market y similares) corre sobre x402 en Base y Solana, donde **cada pago es público
y on-chain**. Eso crea un problema que nadie está resolviendo:

> **El registro de pagos de tu agente es el diagrama de tu estrategia.** Qué modelos consulta, con
> qué frecuencia, cuánto gasta, cuándo acelera — todo visible para tu competencia, tu proveedor y
> cualquier indexador. Pagar se convirtió, sin querer, en delatar cómo trabajas.

No es un problema teórico de privacidad: es fuga de inteligencia competitiva. Un fondo cuyo agente
consulta cierta data-API justo antes de operar, una fintech cuyo agente valida identidades, un
producto cuyo agente llama a un modelo caro solo para clientes premium — todos exponen su ventaja
en el momento de pagar.

**La disyuntiva falsa que rompemos:** *"acceso que puedes probar = acceso vigilado; acceso privado =
acceso que no puedes controlar (spam, abuso)".* Nosotros damos **las dos cosas a la vez**: anónimo
y con consumo finito y auditado.

## 2. La idea, en una frase

> **Separamos pagar de usar.** Pagar puede ser público. **Usar** debe poder probarse sin decir quién
> eres y sin que nadie ligue tu uso con tu pago. La prueba se verifica on-chain en Stellar.

Analogía para no técnicos (fichas de arcade / casino):
1. Compras fichas (pago público, en tu mundo de siempre — Base).
2. Para usar el servicio, presentas una ficha y demuestras que es válida **sin enseñar tu nombre**
   (la prueba ZK).
3. La ficha **se quema** al usarse → sirve una sola vez → nadie abusa.
4. Recibes tu resultado. Y **ni nosotros** podemos saber que "esta ficha" es de "quien la compró".

## 3. Para quién (cliente concreto, no "todos")

**Comprador primario — desarrolladores y fintechs que le cobran a agentes de IA** y necesitan las
cuatro cosas a la vez (si falta una, una API key basta y esto es sobre-ingeniería):
1. medir/gatear el acceso (importa el consumo);
2. el consumidor quiere ocultar identidad o patrón;
3. hay que prevenir abuso/doble-gasto;
4. **nadie** —ni el emisor— debe poder reconstruir el historial.

**Segmentos ordenados por fuerza de encaje** (de VALUE_PROP, priorizados):
- **Gateways de inferencia / API premium** — *flagship*. El cliente esconde qué modelos y cuánto usa.
- **Finanzas reguladas con compliance** — probar "estoy KYC'd / bajo mi límite" sin doxxearte ante
  el protocolo. El mercado más grande y el más alineado con Stellar ("privado cuando se necesita").
- **Data premium / market data** — fondos que no quieren exponer su patrón de consumo.

**Nuestro cliente #0 somos nosotros:** MicoPay usa ZKaaS para gatear sus propios servicios; la infra
que construimos para nosotros es el producto que vendemos (patrón AWS/Stripe). Esto importa para el
pitch: no vendemos una promesa, mostramos algo que ya usamos.

## 4. Por qué Stellar + ZK es la cuña (y no "otra chain de agentes")

Base y Solana **ya ganaron el volumen** agéntico — competir ahí por ser "otro riel de pago" es
perder. La cuña no es el pago; es la **capa de confianza/acceso privado que ese dinero no tiene**:

- **Stellar apuesta explícitamente por "abierto por defecto, privado cuando se necesita"** y añadió
  las funciones BN254 a Soroban para verificar zk-SNARKs **on-chain**. Eso es infraestructura que
  Base/Solana no ofrecen como primitiva de confianza verificable.
- **Stellar no tiene un primitivo nativo de credenciales** (no hay equivalente a EAS). Lo estamos
  construyendo → es infraestructura del ecosistema, no una app más.
- La posición no es "Stellar compite con Base"; es **"Base es la puerta, Stellar es la bóveda"**: el
  agente vive en Base (donde ya está), y Stellar es donde su acceso se vuelve confianza verificable y
  privada. El cruce público→privado es, en sí mismo, la característica.

Frase de posicionamiento:
> **Construimos el carril de acceso privado y rendible para la economía de agentes —la pieza que
> permite consumir sin exponerse— y Stellar es donde esa prueba se vuelve verificable on-chain.**

## 5. Qué es real hoy vs qué es roadmap (para no sobre-vender ante un juez técnico)

**Real y verificado en testnet** (contrato `CBOWU3OV…EUQC7`):
- Tubería completa e2e: comprar credencial (x402) → gastar con proof ZK → Claude responde → re-uso
  bloqueado on-chain (`NullifierAlreadyUsed`). Pago público, gasto anónimo.
- Circuito `access_credential_v1` (burn-once, nullifier determinista), verificado en Soroban.
- Modo `client_generated`: el emisor solo ve `H(secret)`, nunca el secret.

**Roadmap honesto (decir "esto es lo siguiente", no "esto ya está"):**
- Aceptar pagos desde **Base** (EIP-3009) y **Solana** — hoy 0% de código, es el siguiente hito.
- **CCTP** Base→Stellar para tesorería; **pesos/cash** en LatAm (Fase 2, regulada).
- Saldo privado (range proof) y "el set son los propios pagos" (sin emisor de confianza).

**⚠️ Tres cosas que el pitch actual dice y el código matiza — corregir antes de presentar:**
1. **"Ni siquiera nosotros podemos ligar pago↔consumo"** — cierto **solo en modo client-generated**.
   En el modo demo por defecto (pool server-minted), MicoPay conoce los secrets y sí podría ligar.
   → En la demo, **usar/mostrar el modo client-generated**, o decir "en producción el cliente genera
   el secreto" con esa frase, no en absoluto.
2. **"Una sola vez, globalmente / para siempre"** — el nullifier on-chain expira a ~12 días con el
   TTL actual (ver `AUDIT_2026-07.md` C-5). Decir "un solo uso" sin "para siempre" hasta arreglarlo.
3. **Anonimato** — el pool es de 4; el anonimato real baja por correlación temporal y metadatos de
   red. Decir "anonymity set = 4 en el demo, crece con el árbol" (ya está en STATUS, mantenerlo).

Esta honestidad **suma** con jueces de Stellar: el propio VALUE_PROP dice que ZK solo gana su lugar
donde hay algo verdadero que probar y algo que ocultar — mostrar que sabemos exactamente dónde están
los límites es más creíble que un demo sin costuras.

## 6. Guion de demo 2–3 min (jueces no técnicos)

**Antes de empezar** (10 s de contexto): *"Los agentes de IA ya compran servicios solos, y cada
compra es pública. Eso significa que cualquiera ve qué usa tu agente y cómo trabajas. Vamos a
arreglar eso sin volverlo un caos de abuso."*

**Acto 1 — El problema, visible (30 s).** Pantalla con el explorador de un mercado x402: pagos
públicos, "mira, se ve exactamente qué API llamó este agente y cuánto pagó". *"Esto es el diagrama
de su estrategia, a la vista."*

**Acto 2 — Comprar (fichas) (30 s).** `POST /credentials/buy` → *"El agente compra acceso. Este pago
es público, y está bien: un pago no tiene nada que esconder. A cambio recibe una ficha secreta."*
Mostrar que la raíz se ancla en Stellar (un tx en el explorador de Soroban).

**Acto 3 — Usar en anónimo (40 s) — el momento "wow".** `POST /inference` con el proof → Claude
responde. *"El agente demostró que tiene una ficha válida y la gastó, sin decir cuál ni quién es. El
proveedor sirvió el recurso y no aprendió nada de quién es el agente. Y esto —el que nadie pueda unir
la compra con el uso— se verificó en la cadena de Stellar, no confiando en nuestra palabra."*

**Acto 4 — El control (20 s).** Reintentar el mismo proof → `409 nullifier already used`. *"La ficha
se quemó. Anónimo, pero no infinito: cada ficha, un uso. Normalmente para evitar abuso tienes que
identificar a la gente; aquí no."*

**Cierre (20 s).** *"Base tiene el dinero y los agentes. Stellar tiene lo que les falta: probar cosas
en privado, verificado en la cadena. Base es la puerta; Stellar es la bóveda; nosotros somos el
puente invisible. Y no es una demo de laboratorio: es la misma infraestructura que usamos para cobrar
por nuestros propios servicios."*

**Regla de oro del demo:** una sola idea (pagas a la vista, usas en el anonimato, nadie une las dos)
mostrada con tres clics reales (comprar → usar → re-uso bloqueado). No mostrar código; mostrar el
explorador on-chain en los momentos de anclaje y de burn — eso es lo que un juez de Stellar quiere
ver: una afirmación financiera real, probada on-chain, sin filtrar lo sensible.

## 7. Las tres frases que se llevan los jueces

1. **El problema:** *"Pagar por servicios se volvió delatar cómo trabajas."*
2. **La solución:** *"Pagas a la vista, usas en el anonimato, y nadie —ni nosotros— puede unir las
   dos cosas."*
3. **Por qué aquí:** *"Base es la puerta; Stellar es la bóveda donde esa privacidad se vuelve
   verificable on-chain."*
