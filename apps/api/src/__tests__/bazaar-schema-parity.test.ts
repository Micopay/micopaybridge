import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const tableNames = ['bazaar_intents', 'bazaar_quotes', 'agent_history'] as const;

function tableDefinition(source: string, tableName: string): string {
  const escapedName = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${escapedName}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`));
  if (!match?.[1]) throw new Error(`CREATE TABLE definition not found for ${tableName}`);

  // This is the issue's column-parity option: compare complete column
  // declarations (including types and defaults), not table-level constraints.
  return match[1]
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').replace(/,$/, ''))
    .filter((line) => line && !line.startsWith('CONSTRAINT '))
    .join('\n');
}

describe('bazaar schema ownership', () => {
  it.each(tableNames)('%s has the same column definitions in the migration and runtime initializer', async (tableName) => {
    const [migration, runtimeInitializer] = await Promise.all([
      readFile(new URL('../db/migrations/001_initial_schema.sql', import.meta.url), 'utf8'),
      readFile(new URL('../db/bazaar.ts', import.meta.url), 'utf8'),
    ]);

    expect(tableDefinition(runtimeInitializer, tableName)).toBe(tableDefinition(migration, tableName));
  });
});
