// Consultas compartidas entre el worker (Railway) y las funciones API de Vercel
import { q, pool } from './db.js';
import { CONFIG, tradingDate } from './config.js';
import { ACCUMULATORS, dayPlan } from './strategies.js';

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

// ── Lecturas de mercado ─────────────────────────────────────

export async function lastTick(source) {
  const rows = await q(`SELECT * FROM ticks WHERE source = $1 ORDER BY ts DESC LIMIT 1`, [source]);
  return rows[0] || null;
}

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

// Velas OHLC por intervalo (minutos) para una fuente — para la gráfica de velas
export function ohlc(source, intervalMin, sinceTs) {
  const ms = intervalMin * 60_000;
  return q(
    `SELECT (ts / $3) * $3 AS t,
            (array_agg(price ORDER BY ts ASC))[1]  AS o,
            MAX(price) AS h,
            MIN(price) AS l,
            (array_agg(price ORDER BY ts DESC))[1] AS c
     FROM ticks WHERE source = $1 AND ts >= $2
     GROUP BY t ORDER BY t`,
    [source, sinceTs, ms]
  );
}

export async function priceNear(source, ts) {
  const rows = await q(
    `SELECT price FROM ticks WHERE source = $1 AND ts BETWEEN $2 AND $3 ORDER BY ABS(ts - $4) LIMIT 1`,
    [source, ts - 5 * 60_000, ts + 5 * 60_000, ts]
  );
  return rows.length ? rows[0].price : null;
}

export async function spent(date, strategy) {
  // Para el trader, 'spent' = compras netas (buy − sell); para acumuladoras = todo.
  const rows = await q(
    `SELECT COALESCE(SUM(CASE WHEN reason = 'sell' THEN -mxn ELSE mxn END), 0) AS spent
     FROM trades WHERE date = $1 AND strategy = $2`,
    [date, strategy]
  );
  return Number(rows[0].spent);
}

// ── Feeds dashboard ─────────────────────────────────────────

export function recentSignals(limit = 50) {
  return q(`SELECT * FROM signals ORDER BY ts DESC LIMIT $1`, [limit]);
}

// Compras recientes de las estrategias destacadas (para gráfica y tabla)
export async function recentTrades(limit = 80) {
  const trades = await q(
    `SELECT * FROM trades WHERE reason IN ('signal','buy','sell') ORDER BY ts DESC LIMIT $1`, [limit]
  );
  if (!trades.length) return trades;
  const ids = trades.map(t => t.id);
  const outcomes = await q(`SELECT * FROM outcomes WHERE kind = 'trade' AND ref_id = ANY($1)`, [ids]);
  for (const t of trades) t.outcomes = outcomes.filter(o => o.ref_id === t.id);
  return trades;
}

export function recentNews(limit = 30) {
  return q(`SELECT * FROM news ORDER BY ts DESC LIMIT $1`, [limit]);
}

// ── Rendimiento de las acumuladoras ─────────────────────────

const ACC_KEYS = Object.keys(ACCUMULATORS);

// Resumen GLOBAL por estrategia (precio promedio, centavos vs TWAP, ahorro total)
export async function performance() {
  const rows = await q(`
    SELECT strategy, SUM(mxn) AS mxn, SUM(usdt) AS usdt,
           COUNT(CASE WHEN reason IN ('signal','buy') THEN 1 END) AS signal_trades
    FROM trades WHERE strategy = ANY($1) GROUP BY strategy
  `, [ACC_KEYS]);
  const by = {};
  for (const r of rows) by[r.strategy] = { mxn: Number(r.mxn), usdt: Number(r.usdt), signalTrades: Number(r.signal_trades) };
  const twapAvg = by.twap && by.twap.usdt > 0 ? by.twap.mxn / by.twap.usdt : null;

  return ACC_KEYS.map(key => {
    const s = by[key];
    const avg = s && s.usdt > 0 ? s.mxn / s.usdt : null;
    const centavosSaved = avg && twapAvg ? (twapAvg - avg) * 100 : null;
    return {
      strategy: key, label: ACCUMULATORS[key].label, color: ACCUMULATORS[key].color,
      avg, centavosSaved,
      usdt: s ? s.usdt : 0, mxn: s ? s.mxn : 0,
      signalTrades: s ? s.signalTrades : 0,
      savedMxn: centavosSaved !== null ? (centavosSaved / 100) * (s ? s.usdt : 0) : null,
    };
  });
}

// Detalle diario por estrategia (para la tabla histórica)
export async function dailyPerformance(days = 30) {
  const rows = await q(`
    SELECT date, strategy, SUM(mxn) AS mxn, SUM(usdt) AS usdt
    FROM trades WHERE strategy = ANY($1)
    GROUP BY date, strategy ORDER BY date DESC
  `, [ACC_KEYS]);
  const byDate = {};
  for (const r of rows) (byDate[r.date] ??= {})[r.strategy] = { avg: Number(r.usdt) > 0 ? Number(r.mxn) / Number(r.usdt) : null };
  return Object.entries(byDate).slice(0, days).map(([date, s]) => {
    const twapAvg = s.twap?.avg ?? null;
    const cells = {};
    for (const k of ACC_KEYS) {
      const avg = s[k]?.avg ?? null;
      cells[k] = { avg, centavos: avg && twapAvg ? (twapAvg - avg) * 100 : null };
    }
    return { date, cells };
  });
}

// Calidad de señales: % de aciertos y delta promedio por tier y horizonte
export function signalQuality() {
  return q(`
    SELECT s.tier, o.horizon_min,
           COUNT(*)::INT AS n,
           AVG(o.delta_centavos)::float8 AS avg_delta,
           (SUM(CASE WHEN o.delta_centavos > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))::float8 AS hit_rate
    FROM outcomes o JOIN signals s ON s.id = o.ref_id
    WHERE o.kind = 'signal'
    GROUP BY s.tier, o.horizon_min
    ORDER BY s.tier, o.horizon_min
  `);
}

// RFQ vs precio público por hora CDMX (últimos 7 días): ¿en qué horas nuestro
// precio real le gana al público? Positivo = RFQ más barato que Bitso público.
export async function rfqByHour(days = 7) {
  const rows = await q(`
    SELECT EXTRACT(HOUR FROM to_timestamp(ts/1000) AT TIME ZONE $2)::INT AS hr,
           source, AVG(price)::float8 AS avgp, COUNT(*)::INT AS n
    FROM ticks WHERE source IN ('rfq','bitso') AND ts > $1
    GROUP BY hr, source
  `, [Date.now() - days * 86_400_000, CONFIG.TIMEZONE]);
  const byHour = {};
  for (const r of rows) (byHour[r.hr] ??= {})[r.source] = r.avgp;
  const out = [];
  for (let h = 0; h < 24; h++) {
    const b = byHour[h]?.bitso, r = byHour[h]?.rfq;
    out.push({ hour: h, edgeCentavos: b && r ? (b - r) * 100 : null });
  }
  return out;
}

// Estado de presupuesto de hoy para cada acumuladora
export async function todayStats(now = Date.now()) {
  const date = tradingDate(now);
  const strategies = {};
  for (const [key, cfg] of Object.entries(ACCUMULATORS)) {
    const plan = dayPlan(cfg, now);
    strategies[key] = { label: cfg.label, color: cfg.color, spent: await spent(date, key), budget: plan.budget };
  }
  return { date, strategies, budget: CONFIG.DAILY_BUDGET_MXN };
}

// ── Trader: posición y P&L ──────────────────────────────────

// Posición actual del trader (costo promedio ponderado de las compras netas)
export async function traderPosition() {
  const rows = await q(`SELECT reason, mxn, usdt FROM trades WHERE strategy = 'trader' ORDER BY ts`);
  let usdt = 0, cost = 0;
  for (const r of rows) {
    if (r.reason === 'buy') { usdt += Number(r.usdt); cost += Number(r.mxn); }
    else if (r.reason === 'sell') {
      const avg = usdt > 0 ? cost / usdt : 0;
      cost -= avg * Number(r.usdt); usdt -= Number(r.usdt);
      if (usdt < 1e-6) { usdt = 0; cost = 0; }
    }
  }
  return { usdt, avgCost: usdt > 0 ? cost / usdt : 0 };
}

// P&L del trader: realizada (ventas a precio RFQ de venta) + no realizada
// (posición abierta marcada al precio de venta RFQ actual = a cuánto nos la pagarían hoy)
export async function traderPnl() {
  const rows = await q(`SELECT reason, mxn, usdt FROM trades WHERE strategy = 'trader' ORDER BY ts`);
  let usdt = 0, cost = 0, realized = 0, sells = 0, buys = 0;
  for (const r of rows) {
    if (r.reason === 'buy') { usdt += Number(r.usdt); cost += Number(r.mxn); buys++; }
    else if (r.reason === 'sell') {
      const avg = usdt > 0 ? cost / usdt : 0;
      realized += (Number(r.mxn) - avg * Number(r.usdt));
      cost -= avg * Number(r.usdt); usdt -= Number(r.usdt); sells++;
      if (usdt < 1e-6) { usdt = 0; cost = 0; }
    }
  }
  const avgCost = usdt > 0 ? cost / usdt : 0;
  // Marca a mercado al precio de venta real (rfq_sell), o público si no hay
  const sellTick = (await lastTick('rfq_sell')) || (await lastTick('bitso'));
  const sellPrice = sellTick ? sellTick.price : avgCost;
  const unrealizedMxn = usdt > 0 ? usdt * sellPrice - cost : 0;
  return {
    realizedMxn: realized, unrealizedMxn, totalMxn: realized + unrealizedMxn,
    openUsdt: usdt, avgCost, sellPrice, buys, sells,
  };
}

// ── Monitor del efecto viernes ──────────────────────────────
// Compara el precio USDT/MXN justo antes del cierre (vie 14:30 CDMX) contra el
// promedio del fin de semana siguiente, para medir cuánto sube por baja liquidez.
export async function fridayEffect(weeks = 8) {
  const ticks = await q(
    `SELECT ts, price FROM ticks WHERE source = 'bitso' AND ts >= $1 ORDER BY ts`,
    [Date.now() - weeks * 7 * 86_400_000]
  );
  if (!ticks.length) return [];
  const tz = CONFIG.TIMEZONE;
  const parts = ts => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false })
      .formatToParts(new Date(ts));
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.find(x => x.type === 'weekday').value);
    const min = (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ts));
    return { dow, min, date };
  };
  // Precio de cierre de cada viernes (~14:30) y promedio del fin de semana
  const fridayClose = new Map();   // weekKey -> {price, date}
  const weekend = new Map();       // weekKey -> {sum, n}
  for (const t of ticks) {
    const { dow, min, date } = parts(t.ts);
    if (dow === 5 && min >= 14 * 60 && min <= 15 * 60) {
      fridayClose.set(date, { price: Number(t.price), date });
    }
    if (dow === 6 || dow === 0) {
      const wk = weekendKey(t.ts, tz);
      const w = weekend.get(wk) || { sum: 0, n: 0 };
      w.sum += Number(t.price); w.n++; weekend.set(wk, w);
    }
  }
  const out = [];
  for (const [date, fc] of fridayClose) {
    const wk = weekendKey(Date.parse(date + 'T20:30:00Z'), tz);
    const w = weekend.get(wk);
    if (!w) continue;
    const wkAvg = w.sum / w.n;
    out.push({ friday: date, closePrice: fc.price, weekendAvg: wkAvg, deltaCentavos: (wkAvg - fc.price) * 100 });
  }
  return out.slice(-weeks);
}

function weekendKey(ts, tz) {
  // Clave del fin de semana = fecha del sábado (aprox por desplazamiento)
  const d = new Date(ts);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(wd);
  const satTs = ts - ((dow === 0 ? 1 : 0)) * 86_400_000;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(satTs));
}
