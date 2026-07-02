// Siembra "Pro IA" (pro_ai) — replay de alta fidelidad de la variante ganadora del
// backtest unificado: ventana 07-12h CDMX + sizing por veredictos MOMENTUM de Opus
// reales grabados (COMPRAR_FUERTE 15% / COMPRAR 6%, conf>=55, cooldown 5 min) + slots
// con reserva 0.4 y catch-up. Solo días completos desde que existen veredictos momentum.
import { pool } from '../src/db.js';
import { CONFIG } from '../src/config.js';
import { ACCUMULATORS, AI_MIN_CONFIDENCE } from '../src/strategies.js';

const q = (s, p = []) => pool.query(s, p).then(r => r.rows);
const cfg = ACCUMULATORS.pro_ai;
const TZ = CONFIG.TIMEZONE;
const W0 = cfg.windowStart, W1 = cfg.windowEnd;
const cdmxDate = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
const cdmxMin = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ts));
  return (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value);
};

async function main() {
  await pool.query("DELETE FROM trades WHERE strategy='pro_ai'");
  const rfq = await q("SELECT (ts/60000)*60000 m,(array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='rfq' GROUP BY m ORDER BY m");
  const mv = await q("SELECT ts, payload->>'action' a, (payload->>'confidence')::int c FROM analysis WHERE kind='momentum' ORDER BY ts");
  const twap = await q("SELECT date, SUM(mxn) mxn FROM trades WHERE strategy='twap' GROUP BY date");
  const budgetByDate = {}; for (const r of twap) budgetByDate[r.date] = Number(r.mxn);
  const vByMin = new Map(); for (const v of mv) { const m = Math.floor(Number(v.ts)/60000)*60000; if (!vByMin.has(m)) vByMin.set(m, { a: v.a, c: Number(v.c) }); }

  const days = {};
  for (const r of rfq) { const ts = Number(r.m), min = cdmxMin(ts); if (min < W0 || min >= W1) continue; const d = cdmxDate(ts); (days[d] ??= []).push({ ts, min, p: Number(r.p) }); }
  const today = cdmxDate(Date.now());
  const firstV = cdmxDate(Number(mv[0].ts));
  const rows = [];
  for (const [date, mins] of Object.entries(days)) {
    if (date <= firstV || date >= today) continue;   // solo días completos con veredictos
    const budget = budgetByDate[date]; if (!budget) continue;
    let remaining = budget, lastBuy = 0, lastSlot = null;
    for (const { ts, min, p } of mins) {
      const v = vByMin.get(ts);
      if (v && v.c >= AI_MIN_CONFIDENCE && ts - lastBuy >= CONFIG.SIGNAL_COOLDOWN_MS && remaining > 1) {
        const pct = v.a === 'COMPRAR_FUERTE' ? cfg.momFuertePct : v.a === 'COMPRAR' ? cfg.momPct : 0;
        if (pct > 0) { const amt = Math.min(pct * budget, remaining); rows.push([ts, date, 'pro_ai', 'momop', amt, p, amt / p]); remaining -= amt; lastBuy = ts; }
      }
      if (min % 30 === 0 && `${date}:${min}` !== lastSlot && remaining > 1) {
        lastSlot = `${date}:${min}`;
        const slotsLeft = Math.max(1, Math.ceil((W1 - min) / 30));
        const even = remaining / slotsLeft;
        const amt = slotsLeft <= 1 ? remaining : slotsLeft <= 4 ? Math.min(remaining, even) : Math.min(remaining, even * cfg.slotPace);
        if (amt > 0) { rows.push([ts, date, 'pro_ai', 'slot', amt, p, amt / p]); remaining -= amt; }
      }
    }
    if (remaining > 1 && mins.length) { const { ts, p } = mins.at(-1); rows.push([ts, date, 'pro_ai', 'slot', remaining, p, remaining / p]); }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const c = rows.slice(i, i + 500);
    const vals = c.map((_, j) => `($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`).join(',');
    await pool.query(`INSERT INTO trades (ts,date,strategy,reason,mxn,price,usdt) VALUES ${vals}`, c.flat());
  }
  const chk = await q("SELECT date, COUNT(*) n, SUM(mxn) mxn, SUM(usdt) usdt FROM trades WHERE strategy='pro_ai' GROUP BY date ORDER BY date");
  console.log('Sembrado Pro IA:');
  for (const r of chk) console.log('  ' + r.date + ': ' + r.n + ' ops · $' + Math.round(r.mxn).toLocaleString('es-MX') + ' · avg ' + (Number(r.mxn)/Number(r.usdt)).toFixed(4));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
