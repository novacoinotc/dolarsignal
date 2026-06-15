// Conexión a Postgres (Neon) — usada por el worker (Railway) y las funciones de Vercel.
// Para Vercel usa el connection string POOLED de Neon (host con sufijo "-pooler").
import pg from 'pg';
import { CONFIG } from './config.js';

// BIGINT (int8) → Number: ids y timestamps en ms caben en 2^53 sin pérdida
pg.types.setTypeParser(20, Number);

if (!CONFIG.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL (connection string de Neon Postgres)');
}

const isLocal = /localhost|127\.0\.0\.1/.test(CONFIG.DATABASE_URL);

export const pool = new pg.Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
});

pool.on('error', err => console.error('[db] pool error:', err.message));

export async function q(text, params = []) {
  return (await pool.query(text, params)).rows;
}

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticks (
      ts BIGINT NOT NULL,
      source TEXT NOT NULL,          -- 'bitso' | 'spot' | 'fix'
      price DOUBLE PRECISION NOT NULL,
      bid DOUBLE PRECISION, ask DOUBLE PRECISION, volume DOUBLE PRECISION
    );
    CREATE INDEX IF NOT EXISTS idx_ticks ON ticks (source, ts);

    CREATE TABLE IF NOT EXISTS signals (
      id BIGSERIAL PRIMARY KEY,
      ts BIGINT NOT NULL,
      tier TEXT NOT NULL,            -- 'WATCH' | 'BUY' | 'STRONG_BUY' | 'BLOCKED'
      score DOUBLE PRECISION NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      reasons JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals (ts);

    CREATE TABLE IF NOT EXISTS trades (
      id BIGSERIAL PRIMARY KEY,
      ts BIGINT NOT NULL,
      date TEXT NOT NULL,            -- fecha de operación CDMX
      strategy TEXT NOT NULL,        -- 'bot' | 'twap'
      reason TEXT NOT NULL,          -- 'signal' | 'slot' | 'eod'
      mxn DOUBLE PRECISION NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      usdt DOUBLE PRECISION NOT NULL,
      signal_id BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_trades ON trades (date, strategy);

    CREATE TABLE IF NOT EXISTS outcomes (
      kind TEXT NOT NULL,            -- 'trade' | 'signal'
      ref_id BIGINT NOT NULL,
      horizon_min INTEGER NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      delta_centavos DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (kind, ref_id, horizon_min)
    );

    CREATE TABLE IF NOT EXISTS news (
      id BIGSERIAL PRIMARY KEY,
      ts BIGINT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL UNIQUE,
      link TEXT,
      score DOUBLE PRECISION NOT NULL,
      keywords JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_ts ON news (ts);
  `);
}
