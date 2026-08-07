import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, execute } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  console.log('🔄 Running migrations...');

  await execute(`
    CREATE TABLE IF NOT EXISTS migrations_meta (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = await fs.readdir(migrationsDir);
  const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

  const executedMigrations = await query('SELECT name FROM migrations_meta');
  const executedNames = new Set(executedMigrations.rows.map(r => r.name));

  for (const file of sqlFiles) {
    if (!executedNames.has(file)) {
      console.log(`  🚀 Executing migration: ${file}`);
      const filePath = path.join(migrationsDir, file);
      const sql = await fs.readFile(filePath, 'utf-8');

      try {
        await execute(sql);
        await execute('INSERT INTO migrations_meta (name) VALUES ($1)', [file]);
        console.log(`  ✅ Migration ${file} successful`);
      } catch (err) {
        console.error(`  ❌ Migration ${file} failed:`, err);
        throw err;
      }
    }
  }

  console.log('✅ All migrations complete');
}
