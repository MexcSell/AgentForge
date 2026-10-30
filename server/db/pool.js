import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config, ROOT } from '../config.js';

// BIGINT / NUMERIC come back as strings by default; usage numbers fit safely in JS numbers.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ ...config.db, max: 12 });

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export async function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

export async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

export async function migrate() {
  const sql = fs.readFileSync(path.join(ROOT, 'server', 'db', 'schema.sql'), 'utf8');
  // Serialize concurrent migrations (main server + health-check candidate).
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}
