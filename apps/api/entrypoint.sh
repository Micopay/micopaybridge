#!/bin/sh
set -e

echo "Waiting for PostgreSQL..."
until nc -z postgres 5432; do
  sleep 1
done
echo "PostgreSQL is ready!"

echo "Initializing database..."
node -e "
  import('./src/db/schema.js').then(async (db) => {
    console.log('DB connection ready');
  }).catch(() => {
    console.log('DB init skipped');
  });
" 2>/dev/null || true

echo "Starting MicoPay API..."
exec node --import tsx/esm src/index.ts
