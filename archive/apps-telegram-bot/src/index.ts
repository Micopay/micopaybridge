import { readFileSync, existsSync } from 'fs';
import { dirname, join as pathJoin } from 'path';
import { fileURLToPath } from 'url';
import { Bot } from 'grammy';
import axios from 'axios';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = pathJoin(__dirname, '.env');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_URL = process.env.API_URL || 'http://localhost:3000';
const NODE_ENV = process.env.NODE_ENV ?? 'development';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Bot(TELEGRAM_BOT_TOKEN);

const logger = NODE_ENV === 'development'
  ? {
      info: (msg: string, ...args: unknown[]) => console.log(`[INFO] ${msg}`, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[ERROR] ${msg}`, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[WARN] ${msg}`, ...args),
    }
  : {
      info: () => {},
      error: () => {},
      warn: () => {},
    };

async function apiGet<T>(endpoint: string): Promise<T> {
  const response = await axios.get<T>(`${API_URL}${endpoint}`, { timeout: 10000 });
  return response.data;
}

bot.command('start', async (ctx) => {
  const welcome = `👋 *Bienvenido a MicoPay Bot*

Convierte tus USDC en efectivo MXN de forma rápida y segura usando la red Stellar.

*¿Qué puedo hacer?*
• /help - Ver todos los comandos
• /status - Estado del sistema
• /agents - Ver agentes disponibles
• /rate - Ver tasa USDC/MXN
• /register - Registrar un nuevo merchant

¡Empieza a usar MicoPay hoy! 🚀`;

  await ctx.reply(welcome, { parse_mode: 'Markdown' });
});

bot.command('help', async (ctx) => {
  const helpText = `📚 *Ayuda - Comandos disponibles*

/start - Mensaje de bienvenida
/status - Ver estado del sistema
/agents - Lista de agentes disponibles
/rate - Tasa actual USDC/MXN
/register - Registrar nuevo merchant

*Ayuda adicional:*
El bot te conecta con la API de MicoPay para realizar operaciones de cash.`;

  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
  await ctx.reply('⏳ Verificando estado del sistema...');

  try {
    const health = await apiGet<{
      status: string;
      service: string;
      version: string;
      timestamp: string;
      payment_method: string;
      network: string;
    }>('/health');

    const statusEmoji = health.status === 'ok' ? '🟢' : '🔴';
    const statusText = `*Estado del Sistema* ${statusEmoji}

*Servicio:* ${health.service}
*Versión:* ${health.version}
*Método de pago:* ${health.payment_method}
*Red:* ${health.network}
*Última actualización:* ${health.timestamp}`;

    await ctx.reply(statusText, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error fetching status:', error);
    await ctx.reply('❌ Error al obtener el estado del sistema. Intenta más tarde.');
  }
});

bot.command('agents', async (ctx) => {
  await ctx.reply('⏳ Obteniendo agentes disponibles...');

  try {
    const response = await apiGet<{
      agents: Array<{
        id: string;
        name: string;
        type: string;
        address: string;
        distance_km: number;
        available_mxn: number;
        max_trade_mxn: number;
        min_trade_mxn: number;
        tier: string;
        reputation: number;
        online: boolean;
      }>;
      count: number;
      usdc_mxn_rate: number;
    }>('/api/v1/cash/agents?limit=10');

    if (response.agents.length === 0) {
      await ctx.reply('No hay agentes disponibles en este momento.');
      return;
    }

    let message = `💵 *Agentes Disponibles* (${response.count})

*Tasa actual:* 1 USDC = $${response.usdc_mxn_rate} MXN

`;

    response.agents.forEach((agent, index) => {
      const onlineEmoji = agent.online ? '🟢' : '🔴';
      message += `${index + 1}. *${agent.name}* ${onlineEmoji}
   📍 ${agent.address}
   📏 ${agent.distance_km} km
   💰 Disponible: $${agent.available_mxn} MXN
   ⭐ Reputación: ${agent.reputation}%
   🏆 Tier: ${agent.tier}
   
`;
    });

    message += '\n_Usa /register para registrarte como merchant._';

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error fetching agents:', error);
    await ctx.reply('❌ Error al obtener agentes. Intenta más tarde.');
  }
});

bot.command('rate', async (ctx) => {
  await ctx.reply('⏳ Obteniendo tasa de cambio...');

  try {
    const response = await apiGet<{
      agents: Array<{ usdc_rate: number }>;
      usdc_mxn_rate: number;
    }>('/api/v1/cash/agents?limit=1');

    const rate = response.usdc_mxn_rate;
    const inverseRate = (1 / rate).toFixed(6);

    const rateText = `💱 *Tasa de Cambio*

*1 USDC = $${rate} MXN*
*1 MXN = ${inverseRate} USDC*

_Última actualización: ${new Date().toISOString()}_`;

    await ctx.reply(rateText, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error fetching rate:', error);
    await ctx.reply('❌ Error al obtener la tasa. Intenta más tarde.');
  }
});

bot.command('register', async (ctx) => {
  const registerHelp = `📝 *Registrar Merchant*

Para registrarte como merchant necesitas:

1. Una direccion de wallet Stellar (Stellar address)
2. Tener USDC en la red Stellar

*Ejemplo de Stellar address:*
\`GA7HNC7YHLK6JS5R6W7QVQ2V7YK6Z5SM6ZJ6Y2C6ZJ6Z2K5SM6ZJ6Y2C6ZJ6\`

Por favor, proporciona tu Stellar address:`;

  await ctx.reply(registerHelp, { parse_mode: 'Markdown' });
});

bot.on(':text', async (ctx) => {
  const text = ctx.message?.text?.trim() || '';

  if (text.startsWith('G') && text.length >= 56) {
    const stellarAddress = text;

    await ctx.reply(`✅ * Stellar Address Recibida*

Gracias por registrarte. Tu dirección Stellar ha sido registrada:

\`${stellarAddress}\`

⚠️ *Nota:* Esta es una versión de demostración. El registro completo requiere configuración adicional.

Pronto recibirás más información sobre cómo completar tu registro como merchant de MicoPay.`, { parse_mode: 'Markdown' });
    return;
  }

  const unknownText = `Lo siento, no entendí tu mensaje.

Usa /help para ver los comandos disponibles o /register para registrarte como merchant.`;

  await ctx.reply(unknownText);
});

bot.catch((err) => {
  logger.error('Bot error:', err);
});

async function start() {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Mensaje de bienvenida' },
      { command: 'help', description: 'Lista de comandos' },
      { command: 'status', description: 'Estado del sistema' },
      { command: 'agents', description: 'Agentes disponibles' },
      { command: 'rate', description: 'Tasa USDC/MXN' },
      { command: 'register', description: 'Registrar merchant' },
    ]);

    logger.info('Bot started successfully');
    await bot.start();
  } catch (err) {
    logger.error('Failed to start bot:', err);
    process.exit(1);
  }
}

start();
