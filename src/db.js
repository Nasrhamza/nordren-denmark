import pg from 'pg';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { root } from './config.js';

export async function openDatabase(config) {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    pool.on('error', () => console.error('Database connection error'));
    return {
      query: (sql, values) => pool.query(sql, values),
      async transaction(fn) {
        const client = await pool.connect();
        try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
        catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      }, close: () => pool.end()
    };
  }
  if (config.production) throw new Error('Production requires PostgreSQL');
  // PostgreSQL WASM for local development/tests only, never a production fallback.
  const { PGlite } = await import('@electric-sql/pglite');
  if (config.dataDir) await mkdir(config.dataDir, { recursive: true });
  const db = new PGlite(config.dataDir ? path.join(config.dataDir, 'postgres') : undefined);
  await db.waitReady;
  return { query: (sql, values) => db.query(sql, values), transaction: fn => db.transaction(fn), close: () => db.close() };
}

export async function migrate(db) {
  await db.transaction(async tx => {
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    await tx.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    for (const file of (await readdir(path.join(root, 'migrations'))).filter(f => f.endsWith('.sql')).sort()) {
      if ((await tx.query('SELECT name FROM schema_migrations WHERE name=$1', [file])).rows.length) continue;
      const sql = await readFile(path.join(root, 'migrations', file), 'utf8');
      for (const statement of sql.split(';').filter(s => s.trim())) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
    }
  });
}
