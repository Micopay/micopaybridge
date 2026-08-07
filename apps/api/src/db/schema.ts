import pg from 'pg';
const { Pool } = pg;
import { config } from '../config.js';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      // pg trae connectionTimeoutMillis en 0, que significa esperar para
      // siempre. Con la base rechazando conexión falla rápido, pero con un
      // host que no responde —firewall, DNS lento— la petición se queda
      // colgada sin límite. Un pago x402 no puede esperar indefinidamente a
      // una base que además es opcional: hay fallback en memoria.
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5_000),
    });
    pool.on('error', (err: Error) => {
      console.error('PostgreSQL error:', err.message);
    });
  }
  return pool;
}

export const poolProxy = {
  query: (text: string, params?: any[]) => getPool().query(text, params),
};

export async function query(text: string, params?: any[]) {
  return getPool().query(text, params);
}

export async function getOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const result = await getPool().query(text, params);
  return result.rows[0] || null;
}

export async function getMany<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows;
}

export async function execute(text: string, params?: any[]) {
  return getPool().query(text, params);
}

export default { query, getOne, getMany, execute };
