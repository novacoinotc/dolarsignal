import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carga .env si existe (para desarrollo local; en Railway/Vercel usar env vars)
const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const CONFIG = {
  ROOT,
  DATABASE_URL: process.env.DATABASE_URL || '',
  TIMEZONE: 'America/Mexico_City',

  // ── Fondo de paper trading ────────────────────────────────
  DAILY_BUDGET_MXN: 20_000_000,   // presupuesto diario de compra
  TWAP_SLOT_MINUTES: 30,          // referencia TWAP: compra cada 30 min
  SIGNAL_BUY_PCT: 0.02,           // compra por señal BUY: 2% del presupuesto diario
  STRONG_BUY_PCT: 0.05,           // compra por señal STRONG_BUY: 5%
  SIGNAL_COOLDOWN_MS: 5 * 60_000, // espera mínima entre compras por señal

  // ── Cadencias de polling ──────────────────────────────────
  BITSO_POLL_MS: 15_000,
  SPOT_POLL_MS: 60_000,
  NEWS_POLL_MS: 5 * 60_000,
  EVAL_POLL_MS: 60_000,

  // ── Motor de señales ──────────────────────────────────────
  ZSCORE_WINDOW_MIN: 60,          // ventana para z-score (minutos)
  ZSCORE_DIP: -1.5,               // dip fuerte
  ZSCORE_SOFT: -1.0,              // dip moderado
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 30,
  RSI_EXTREME: 20,
  BOLLINGER_PERIOD: 20,
  BOLLINGER_K: 2,
  DROP_LOOKBACK_MIN: 5,           // caída rápida: ventana
  DROP_PCT: -0.0005,              // -0.05% en 5 min
  PREMIUM_WINDOW_MIN: 240,        // ventana para z-score de la prima USDT
  SCORE_WATCH: 1.5,
  SCORE_BUY: 2.5,
  SCORE_STRONG: 4.0,

  // ── Ventanas de riesgo por eventos ────────────────────────
  EVENT_BLACKOUT_BEFORE_MIN: 45,  // no comprar X min antes de evento high-impact
  EVENT_BLACKOUT_AFTER_MIN: 15,

  // ── Horizontes de evaluación de resultados (minutos) ──────
  OUTCOME_HORIZONS: [15, 60, 240],

  // ── Alertas ───────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  BANXICO_TOKEN: process.env.BANXICO_TOKEN || '',

  // ── Dashboard local / Railway ─────────────────────────────
  PORT: Number(process.env.PORT || 8420),
};

// Fecha de operación en zona horaria CDMX, formato YYYY-MM-DD
export function tradingDate(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE }).format(new Date(ts));
}

export function cdmxTime(ts = Date.now()) {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: CONFIG.TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ts));
}
