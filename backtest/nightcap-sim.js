// ¿Conviene limitar cuánto compra el espejo real ANTES de las 8am?
// Simula el ejecutor sobre todo el periodo vivo: espeja las compras paper de smart_ai
// (a su precio RFQ real) con un TOPE NOCTURNO = X% del cupo diario antes de las 8am;
// lo que quede sin gastar lo compra un "pacer" repartido por hora (8-22h) al RFQ de esa
// hora — exactamente el mecanismo que se implementaría. Benchmark: TWAP RFQ 8-22h del día.
import { pool } from '../src/db.js';

const q = (s, p = []) => pool.query(s, p).then(r => r.rows);
const MX = "to_timestamp(ts/1000.0) AT TIME ZONE 'America/Mexico_City'";
const CAP = 5_250_000, SCALE = CAP / 25_000_000, MIN = 20_000;

// compras paper de smart_ai con hora CDMX
const trades = await q(`
  SELECT date, extract(hour FROM ${MX})::int h, extract(minute FROM ${MX})::int mi, mxn, price
  FROM trades WHERE strategy='smart_ai' ORDER BY ts`);
// RFQ promedio por (día, hora) — precio del pacer y benchmark
const rfq = await q(`
  SELECT to_char(${MX},'YYYY-MM-DD') d, extract(hour FROM ${MX})::int h, AVG(price) p
  FROM ticks WHERE source='rfq' GROUP BY 1,2`);
await pool.end();
const rfqAt = new Map(rfq.map(r => [`${r.d}:${r.h}`, Number(r.p)]));
const ops = {};
for (const r of rfq) if (r.h >= 8 && r.h < 22) (ops[r.d] ??= []).push(Number(r.p));
const opsTw = Object.fromEntries(Object.entries(ops).filter(([, a]) => a.length >= 8).map(([d, a]) => [d, a.reduce((x, y) => x + y, 0) / a.length]));

const byDay = {};
for (const t of trades) (byDay[t.date] ??= []).push(t);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const DAYS = Object.keys(byDay).filter(d => d < today && opsTw[d]).sort();

function simDay(day, nightPct) {
  const nightCap = CAP * nightPct;
  let spent = 0, night = 0, mxnTot = 0, usdt = 0;
  const buy = (m, px) => { if (m < 1 || !px) return; mxnTot += m; usdt += m / px; spent += m; };
  // eventos: espejos (a su minuto) + pacer en cada hora 8-21 (min 59, tras los espejos de esa hora)
  const ev = byDay[day].map(t => ({ k: t.h * 60 + t.mi, type: 'm', mxn: Number(t.mxn), px: Number(t.price), h: t.h }));
  for (let h = 8; h < 22; h++) ev.push({ k: h * 60 + 59, type: 'p', h });
  ev.sort((a, b) => a.k - b.k);
  for (const e of ev) {
    const left = CAP - spent;
    if (left < MIN) break;
    if (e.type === 'm') {
      let m = Math.min(Math.max(Math.round(e.mxn * SCALE), MIN), left);
      if (e.h < 8) { m = Math.min(m, nightCap - night); if (m < MIN) continue; night += m; }
      buy(m, e.px);
    } else {
      // pacer: reparte lo restante en las horas que quedan hasta las 22h
      const hoursLeft = 22 - e.h;
      const m = Math.min(Math.max(left / hoursLeft, MIN), left);
      buy(Math.round(m), rfqAt.get(`${day}:${e.h}`));
    }
  }
  if (!usdt) return null;
  return { cent: (opsTw[day] - mxnTot / usdt) * 100, usdt, spent };
}

console.log(`días simulados: ${DAYS.length} (cupo $${CAP.toLocaleString('es-MX')}/día, min $${MIN.toLocaleString('es-MX')})`);
console.log('\ntope nocturno   ¢/día    $/año(≈)     %d+   peor    mejor   sd');
for (const pct of [0, 0.25, 0.4, 0.6, 1]) {
  const res = DAYS.map(d => simDay(d, pct)).filter(Boolean);
  const cents = res.map(r => r.cent);
  const avg = cents.reduce((x, y) => x + y, 0) / cents.length;
  const sd = Math.sqrt(cents.reduce((x, y) => x + (y - avg) ** 2, 0) / (cents.length - 1));
  const usdtDay = res.reduce((s, r) => s + r.usdt, 0) / res.length;
  const yr = avg / 100 * usdtDay * 250;
  const tag = pct === 1 ? 'SIN tope (hoy)' : `${(pct * 100).toFixed(0)}% ($${(CAP * pct / 1e6).toFixed(2)}M)`;
  console.log(`  ${tag.padEnd(15)} ${avg.toFixed(3).padStart(6)}  $${Math.round(yr).toLocaleString('es-MX').padStart(9)}  ${Math.round(100 * cents.filter(x => x > 0).length / cents.length).toString().padStart(4)}%  ${Math.min(...cents).toFixed(1).padStart(5)}  ${Math.max(...cents).toFixed(1).padStart(6)}  ${sd.toFixed(2)}`);
}
// detalle de los últimos 10 días: sin tope vs 40%
console.log('\núltimos 10 días (¢): sin tope → con tope 40%');
for (const d of DAYS.slice(-10)) {
  const a = simDay(d, 1), b = simDay(d, 0.4);
  if (a && b) console.log(`  ${d}  ${a.cent.toFixed(2).padStart(6)} → ${b.cent.toFixed(2).padStart(6)}`);
}
