// Siembra "Tesorero" desde el 16 jun: replay determinista del regime-switcher exacto
// (régimen = cambio del día previo en ¢; motor REV con z de 24h sobre cierres horarios
// de bitso; REVLIGHT ejecutable = chunks a la mitad; ejecución al RFQ real de la hora).
// Presupuesto diario = el del TWAP de ese día. Igual que seed-hybrid.js.
import { pool } from '../src/db.js';
import { CONFIG } from '../src/config.js';
import { TESORERO } from '../src/strategies.js';
import { zscore } from '../src/indicators.js';

const q = (s, p = []) => pool.query(s, p).then(r => r.rows);
const TZ = CONFIG.TIMEZONE;
const dParts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')) % 24 };
};

async function main() {
  await pool.query("DELETE FROM trades WHERE strategy='tesorero'");
  const bit = await q("SELECT (ts/3600000)*3600000 h,(array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='bitso' GROUP BY h ORDER BY h");
  const rfq = await q("SELECT (ts/3600000)*3600000 h,(array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='rfq' GROUP BY h ORDER BY h");
  const twap = await q("SELECT date, SUM(mxn) mxn FROM trades WHERE strategy='twap' GROUP BY date");
  const budgetByDate = {}; for (const r of twap) budgetByDate[r.date] = Number(r.mxn);
  const rfqAt = new Map(rfq.map(r => [Number(r.h), Number(r.p)]));

  const seq = bit.map(r => ({ ts: Number(r.h), ...dParts(Number(r.h)), p: Number(r.p) }));
  const closes = seq.map(x => x.p);
  const zAt = i => { const h = closes.slice(Math.max(0, i - 24), i); return h.length < 12 ? null : zscore(h, closes[i]); };
  const today = dParts(Date.now()).date;

  // cambio de cada día (¢) para el régimen del día siguiente
  const byDate = {};
  for (const x of seq) (byDate[x.date] ??= []).push(x.p);
  const dates = Object.keys(byDate).sort();
  const chg = {}; for (const d of dates) { const a = byDate[d]; chg[d] = (a.at(-1) - a[0]) * 100; }
  const prevOf = {}; for (let i = 1; i < dates.length; i++) prevOf[dates[i]] = dates[i - 1];

  const T = TESORERO;
  const rows = [];
  let cur = null, remaining = 0, budget = 0, mode = 'light', f = 1;
  for (let i = 0; i < seq.length; i++) {
    const { ts, date, h, p } = seq[i];
    if (date >= today) continue;
    if (date !== cur) {
      cur = date; budget = budgetByDate[date] || 0; remaining = budget;
      const pc = prevOf[date] != null ? chg[prevOf[date]] : null;
      mode = pc == null ? 'light' : pc > T.trendT ? 'ops' : pc < -T.trendT ? 'rev' : 'light';
      f = mode === 'light' ? T.lightFactor : 1;
    }
    if (budget < 1 || remaining < 1) continue;
    const exec = rfqAt.get(ts) || p;
    const z = zAt(i);
    let amt = 0, reason = 'slot';
    if (h < T.nightEnd) {
      if (mode !== 'ops' && z != null && z <= T.zStrong) { amt = Math.min(budget * T.strongPct * f, remaining); reason = 'dip'; }
    } else if (h < T.endHour) {
      const left = T.endHour - h;
      if (left <= 1) amt = remaining;
      else if (mode === 'ops') amt = remaining / left;
      else if (left <= T.finalHours) amt = remaining / left;
      else if (z != null && z <= T.zStrong) { amt = Math.min(budget * T.strongPct * f, remaining); reason = 'dip'; }
      else if (z != null && z <= T.zDip) { amt = Math.min(budget * T.dipPct * f, remaining); reason = 'dip'; }
      else if (z != null && z >= T.zDefer) amt = 0;
      else amt = Math.min(remaining, remaining / left * T.pace);
    }
    if (amt >= 1) { rows.push([ts, date, 'tesorero', reason, amt, exec, amt / exec]); remaining -= amt; }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const c = rows.slice(i, i + 500);
    const vals = c.map((_, j) => `($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`).join(',');
    await pool.query(`INSERT INTO trades (ts,date,strategy,reason,mxn,price,usdt) VALUES ${vals}`, c.flat());
  }
  const chk = await q("SELECT date, COUNT(*) n, COUNT(CASE WHEN reason='dip' THEN 1 END) dips, SUM(mxn) mxn, SUM(usdt) usdt FROM trades WHERE strategy='tesorero' GROUP BY date ORDER BY date");
  console.log('Sembrado Tesorero:');
  for (const r of chk) console.log('  ' + r.date + ': ' + r.n + ' ops (' + r.dips + ' dips) · $' + Math.round(r.mxn).toLocaleString('es-MX') + ' · avg ' + (Number(r.mxn)/Number(r.usdt)).toFixed(4));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
