// Consultas compartidas entre el worker (Railway) y las funciones API de Vercel
import { q, pool } from './db.js';
import { CONFIG, tradingDate } from './config.js';

// ── Escrituras (worker) ─────────────────────────────────────

export function insertTick(t) {
  return q(
    `INSERT INTO ticks (ts, source, price, bid, ask, volume) VALUES ($1, $2, $3, $4, $5, $6)`,
    [t.ts, t.source, t.price, t.bid ?? null, t.ask ?? null, t.volume ?? null]
  );
}

export async function insertSignal(s) {
  const rows = await q(
    `INSERT INTO signals (ts, tier, score, price, reasons) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [s.ts, s.tier, s.score, s.price, JSON.stringify(s.reasons)]
  );
  return rows[0].id;
}

export function insertTrade(t) {
  return q(
    `INSERT INTO trades (ts, date, strategy, reason, mxn, price, usdt, signal_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [t.ts, t.date, t.strategy, t.reason, t.mxn, t.price, t.usdt, t.signalId ?? null]
  );
}

export function insertOutcome(o) {
  return q(
    `INSERT INTO outcomes (kind, ref_id, horizon_min, price, delta_centavos) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [o.kind, o.refId, o.horizonMin, o.price, o.delta]
  );
}

// Devuelve true si la noticia es nueva
export async function insertNews(n) {
  const res = await pool.query(
    `INSERT INTO news (ts, source, title, link, score, keywords) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (title) DO NOTHING`,
    [n.ts, n.source, n.title, n.link ?? null, n.score, JSON.stringify(n.keywords)]
  );
  return res.rowCount > 0;
}

// ── Lecturas ────────────────────────────────────────────────

export async function lastTick(source) {
  const rows = await q(`SELECT * FROM ticks WHERE source = $1 ORDER BY ts DESC LIMIT 1`, [source]);
  return rows[0] || null;
}

// Cierres por minuto (último precio de cada minuto)
export function minuteCloses(source, sinceTs) {
  return q(
    `SELECT bucket, price FROM (
       SELECT (ts / 60000) * 60000 AS bucket, price,
              ROW_NUMBER() OVER (PARTITION BY ts / 60000 ORDER BY ts DESC) AS rn
       FROM ticks WHERE source = $1 AND ts >= $2
     ) t WHERE rn = 1 ORDER BY bucket`,
    [source, sinceTs]
  );
}

// Precio más cercano a un timestamp (±5 min)
export async function priceNear(source, ts) {
  const rows = await q(
    `SELECT price FROM ticks WHERE source = $1 AND ts BETWEEN $2 AND $3 ORDER BY ABS(ts - $4) LIMIT 1`,
    [source, ts - 5 * 60_000, ts + 5 * 60_000, ts]
  );
  return rows.length ? rows[0].price : null;
}

export async function spent(date, strategy) {
  const rows = await q(
    `SELECT COALESCE(SUM(mxn), 0) AS spent FROM trades WHERE date = $1 AND strategy = $2`,
    [date, strategy]
  );
  return Number(rows[0].spent);
}

export function recentSignals(limit = 50) {
  return q(`SELECT * FROM signals ORDER BY ts DESC LIMIT $1`, [limit]);
}

export async function recentBotTrades(limit = 60) {
  const trades = await q(`SELECT * FROM trades WHERE strategy = 'bot' ORDER BY ts DESC LIMIT $1`, [limit]);
  if (!trades.length) return trades;
  const ids = trades.map(t => t.id);
  const outcomes = await q(
    `SELECT * FROM outcomes WHERE kind = 'trade' AND ref_id = ANY($1)`, [ids]
  );
  for (const t of trades) t.outcomes = outcomes.filter(o => o.ref_id === t.id);
  return trades;
}

export function recentNews(limit = 30) {
  return q(`SELECT * FROM news ORDER BY ts DESC LIMIT $1`, [limit]);
}

// Comparativa diaria bot vs TWAP: centavos ganados por USDT y ahorro total MXN
export async function performance() {
  const rows = await q(`
    SELECT date, strategy,
           SUM(mxn) AS mxn, SUM(usdt) AS usdt,
           SUM(CASE WHEN reason = 'signal' THEN mxn ELSE 0 END) AS signal_mxn,
           COUNT(CASE WHEN reason = 'signal' THEN 1 END) AS signal_trades
    FROM trades GROUP BY date, strategy ORDER BY date DESC
  `);
  const byDate = {};
  for (const r of rows) (byDate[r.date] ??= {})[r.strategy] = r;
  return Object.entries(byDate).map(([date, s]) => {
    const bot = s.bot, twap = s.twap;
    const botAvg = bot && Number(bot.usdt) > 0 ? Number(bot.mxn) / Number(bot.usdt) : null;
    const twapAvg = twap && Number(twap.usdt) > 0 ? Number(twap.mxn) / Number(twap.usdt) : null;
    const centavosSaved = botAvg && twapAvg ? (twapAvg - botAvg) * 100 : null;
    return {
      date, botAvg, twapAvg, centavosSaved,
      botUsdt: Number(bot?.usdt || 0),
      botMxn: Number(bot?.mxn || 0),
      signalTrades: Number(bot?.signal_trades || 0),
      signalMxn: Number(bot?.signal_mxn || 0),
      savedMxn: centavosSaved !== null ? (centavosSaved / 100) * Number(bot?.usdt || 0) : null,
    };
  });
}

// Calidad de señales: % de aciertos y delta promedio por tier y horizonte
export function signalQuality() {
  return q(`
    SELECT s.tier, o.horizon_min,
           COUNT(*)::INT AS n,
           AVG(o.delta_centavos) AS avg_delta,
           SUM(CASE WHEN o.delta_centavos > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS hit_rate
    FROM outcomes o JOIN signals s ON s.id = o.ref_id
    WHERE o.kind = 'signal'
    GROUP BY s.tier, o.horizon_min
    ORDER BY s.tier, o.horizon_min
  `);
}

export async function todayStats(now = Date.now()) {
  const date = tradingDate(now);
  const [botSpent, twapSpent] = await Promise.all([spent(date, 'bot'), spent(date, 'twap')]);
  return { date, botSpent, twapSpent, budget: CONFIG.DAILY_BUDGET_MXN };
}
