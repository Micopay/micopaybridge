import pg from 'pg';
const { Pool } = pg;
import { config } from '../config.js';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl });
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
