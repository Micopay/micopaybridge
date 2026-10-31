/**
 * setup-platform-mainnet.mjs
 *
 * Alta de la cuenta de plataforma en Stellar mainnet: es la `payTo` de x402
 * (se deriva de PLATFORM_SECRET_KEY) y sin ella ningún agente puede pagar.
 *
 *   node scripts/setup-platform-mainnet.mjs new
 *       Genera una llave nueva en esta máquina. El secreto va directo a
 *       Secrets Manager / SSM del deploy; nunca a Railway, al repo ni a un chat.
 *
 *   (a mano) Enviar ~3 XLM a la dirección pública desde una wallet propia.
 *       Crea la cuenta y cubre la reserva base + la de la trustline.
 *
 *   PLATFORM_SECRET_KEY=S... node scripts/setup-platform-mainnet.mjs trustline
 *       Agrega la trustline de USDC (emisor Circle) para poder recibir pagos.
 *
 *   node scripts/setup-platform-mainnet.mjs check G...
 *       Solo lectura: ¿existe la cuenta?, saldo XLM, ¿tiene trustline USDC?
 */

import * as StellarSdk from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon.stellar.org";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC = new StellarSdk.Asset("USDC", USDC_ISSUER);
const server = new StellarSdk.Horizon.Server(HORIZON_URL);

async function check(address) {
  try {
    const acc = await server.loadAccount(address);
    const xlm = acc.balances.find((b) => b.asset_type === "native")?.balance;
    const usdc = acc.balances.find(
      (b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER,
    );
    console.log(`Cuenta:    ${address}`);
    console.log(`Existe:    sí`);
    console.log(`XLM:       ${xlm}`);
    console.log(`USDC:      ${usdc ? `trustline OK, saldo ${usdc.balance}` : "SIN trustline"}`);
    return Boolean(usdc);
  } catch (e) {
    if (e?.response?.status === 404) {
      console.log(`Cuenta:    ${address}`);
      console.log("Existe:    NO — enviarle ~3 XLM desde una wallet propia para crearla");
      return false;
    }
    throw e;
  }
}

async function trustline() {
  const secret = process.env.PLATFORM_SECRET_KEY;
  if (!secret) throw new Error("Falta PLATFORM_SECRET_KEY en el entorno");
  const kp = StellarSdk.Keypair.fromSecret(secret);
  if (await check(kp.publicKey())) {
    console.log("\nYa tiene trustline USDC; nada que hacer.");
    return;
  }
  const acc = await server.loadAccount(kp.publicKey());
  const tx = new StellarSdk.TransactionBuilder(acc, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.PUBLIC,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  console.log(`\nTrustline USDC creada: https://stellar.expert/explorer/public/tx/${res.hash}`);
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "new") {
  const kp = StellarSdk.Keypair.random();
  console.log(`Pública (payTo de x402): ${kp.publicKey()}`);
  console.log(`Secreta (PLATFORM_SECRET_KEY): ${kp.secret()}`);
  console.log("\nGuarda la secreta solo en el gestor de secretos del deploy y limpia esta terminal.");
} else if (cmd === "trustline") {
  await trustline();
} else if (cmd === "check" && arg) {
  await check(arg);
} else {
  console.log("Uso: new | trustline | check <G...>  (ver cabecera del archivo)");
  process.exitCode = 1;
}
