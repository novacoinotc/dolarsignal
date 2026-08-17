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
  DAILY_BUDGET_MXN: 25_000_000,   // presupuesto diario de compra (venta real diaria)
  TWAP_SLOT_MINUTES: 30,          // referencia TWAP: compra cada 30 min
  SIGNAL_BUY_PCT: 0.02,           // compra por señal BUY: 2% del presupuesto diario
  STRONG_BUY_PCT: 0.05,           // compra por señal STRONG_BUY: 5%
  SIGNAL_COOLDOWN_MS: 5 * 60_000, // espera mínima entre compras por señal

  // ── Cadencias de polling ──────────────────────────────────
  BITSO_POLL_MS: 15_000,
  SPOT_POLL_MS: 60_000,
  BTC_POLL_MS: 30_000,
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
  BTC_WINDOW_MIN: 60,             // ventana para el z-score de BTC
  BTC_PUMP_Z: 1.5,                // BTC subiendo fuerte → presión bajista en USDT (buena compra)
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

  // ── Bitso RFQ (SOLO LECTURA del precio real institucional) ─
  BITSO_API_KEY: process.env.BITSO_API_KEY || '',
  BITSO_API_SECRET: process.env.BITSO_API_SECRET || '',
  RFQ_QUOTE_MXN: Number(process.env.RFQ_QUOTE_MXN || 100_000),  // referencia de compra (el RFQ no depende del tamaño)
  RFQ_QUOTE_USDT: Number(process.env.RFQ_QUOTE_USDT || 5_000),  // referencia de venta (USDT)
  RFQ_POLL_MS: Number(process.env.RFQ_POLL_MS || 30_000),       // cotiza seguido: es el precio de ejecución del paper trading

  // ── EJECUCIÓN REAL (tesorería) — la única sección que puede mover dinero ──
  //  EXEC_MODE: 'off' = apagado (kill-switch) | 'dry' = cotiza pero NO compra | 'live' = compra REAL
  EXEC_MODE: (process.env.EXEC_MODE || 'off').toLowerCase(),
  EXEC_DAILY_CAP_MXN: Number(process.env.EXEC_DAILY_CAP_MXN || 500_000),   // tope diario duro
  EXEC_MAX_PREMIUM_CENT: Number(process.env.EXEC_MAX_PREMIUM_CENT || 6),   // rechaza si prima RFQ > 6¢ vs público
  EXEC_MIN_MXN: Number(process.env.EXEC_MIN_MXN || 20_000),                // mínimo por compra (Bitso RFQ exige ≥$17,500 MXN)
  // Estrategia a espejar en real: nombre fijo (ej. 'smart_ai') o 'capitan' (switcher por régimen).
  // Default smart_ai: la líder 3/3 ventanas y mayor $ acumulado del laboratorio (2026-07-18).
  EXEC_STRATEGY: process.env.EXEC_STRATEGY || 'smart_ai',
  // Ventana de compras REALES: se detiene el viernes a esta hora (CDMX) y reanuda
  // lunes 00:00 — el RFQ de fin de semana cobra ~+0.6¢ extra (medido en vivo).
  EXEC_FRIDAY_CUTOFF_HOUR: Number(process.env.EXEC_FRIDAY_CUTOFF_HOUR || 16),

  // ── Agente de IA (scout Haiku + analista Opus) ────────────
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  SCOUT_MODEL: process.env.SCOUT_MODEL || 'claude-haiku-4-5',   // "el chismoso": revisa todo cada minuto, barato
  ANALYST_MODEL: process.env.ANALYST_MODEL || 'claude-opus-4-8', // toma las decisiones cuando el scout escala
  SCOUT_POLL_MS: Number(process.env.SCOUT_POLL_MS || 60_000),  // el scout revisa cada minuto
  // 2º cerebro Opus con mentalidad momentum: solo alimenta estrategias PAPER
  // (momentum_opus, pro_ai). Apagado por defecto desde 2026-08-03 para ahorrar
  // ~50% del gasto de Opus; reactivable con MOMENTUM_BRAIN=on.
  MOMENTUM_BRAIN: (process.env.MOMENTUM_BRAIN || 'off').toLowerCase(),
  ANALYST_MIN_GAP_MS: 5 * 60_000,   // no llamar a Opus más seguido que esto (salvo urgencia alta)
  ANALYST_MAX_GAP_MS: 30 * 60_000,  // pero al menos cada 30 min hay un análisis fresco de Opus

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
