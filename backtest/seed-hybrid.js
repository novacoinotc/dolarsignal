// Siembra "Híbrido" desde el 16 jun: replay determinista de la receta exacta
// (decisión horaria: z del precio actual vs 24h previas de bitso; ejecución al RFQ).
// Presupuesto diario = el del TWAP de ese día. Solo días completos.
import { pool } from '../src/db.js';
import { CONFIG } from '../src/config.js';
import { HYBRID } from '../src/strategies.js';
import { zscore } from '../src/indicators.js';

const q = (s, p = []) => pool.query(s, p).then(r => r.rows);
const TZ = CONFIG.TIMEZONE;
const dParts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')) % 24 };
};

async function main() {
  await pool.query("DELETE FROM trades WHERE strategy='hybrid'");
  // cierres horarios de bitso (detección) y rfq (ejecución)
  const bit = await q("SELECT (ts/3600000)*3600000 h,(array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='bitso' GROUP BY h ORDER BY h");
  const rfq = await q("SELECT (ts/3600000)*3600000 h,(array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='rfq' GROUP BY h ORDER BY h");
  const twap = await q("SELECT date, SUM(mxn) mxn FROM trades WHERE strategy='twap' GROUP BY date");
  const budgetByDate = {}; for (const r of twap) budgetByDate[r.date] = Number(r.mxn);
  const rfqAt = new Map(rfq.map(r => [Number(r.h), Number(r.p)]));

  const seq = bit.map(r => ({ ts: Number(r.h), ...dParts(Number(r.h)), p: Number(r.p) }));
  const closes = seq.map(x => x.p);
  const zAt = i => { const h = closes.slice(Math.max(0, i - 24), i); return h.length < 12 ? null : zscore(h, closes[i]); };
  const today = dParts(Date.now()).date;

  const rows = [];
  let cur = null, remaining = 0, budget = 0;
  for (let i = 0; i < seq.length; i++) {
    const { ts, date, h, p } = seq[i];
    if (date >= today) continue;
    if (date !== cur) { cur = date; budget = budgetByDate[date] || 0; remaining = budget; }
    if (budget < 1 || remaining < 1) continue;
    const exec = rfqAt.get(ts) || p;              // precio RFQ real de esa hora
    const z = zAt(i);
    let amt = 0, reason = 'slot';
    if (h < HYBRID.nightEnd) {
      if (z != null && z <= HYBRID.zStrong) { amt = Math.min(budget * HYBRID.strongPct, remaining); reason = 'dip'; }
    } else if (h < HYBRID.endHour) {
      const left = HYBRID.endHour - h;
      if (left <= 1) amt = remaining;
      else if (left <= HYBRID.finalHours) amt = remaining / left;
      else if (z != null && z <= HYBRID.zStrong) { amt = Math.min(budget * HYBRID.strongPct, remaining); reason = 'dip'; }
      else if (z != null && z <= HYBRID.zDip) { amt = Math.min(budget * HYBRID.dipPct, remaining); reason = 'dip'; }
      else if (z != null && z >= HYBRID.zDefer) amt = 0;
      else amt = Math.min(remaining, remaining / left * HYBRID.pace);
    }
    if (amt >= 1) { rows.push([ts, date, 'hybrid', reason, amt, exec, amt / exec]); remaining -= amt; }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const c = rows.slice(i, i + 500);
    const vals = c.map((_, j) => `($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`).join(',');
    await pool.query(`INSERT INTO trades (ts,date,strategy,reason,mxn,price,usdt) VALUES ${vals}`, c.flat());
  }
  const chk = await q("SELECT date, COUNT(*) n, COUNT(CASE WHEN reason='dip' THEN 1 END) dips, SUM(mxn) mxn, SUM(usdt) usdt FROM trades WHERE strategy='hybrid' GROUP BY date ORDER BY date");
  console.log('Sembrado Híbrido:');
  for (const r of chk) console.log('  ' + r.date + ': ' + r.n + ' ops (' + r.dips + ' dips) · $' + Math.round(r.mxn).toLocaleString('es-MX') + ' · avg ' + (Number(r.mxn)/Number(r.usdt)).toFixed(4));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
