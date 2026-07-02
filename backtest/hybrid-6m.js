// Backtest del HÍBRIDO en los ÚLTIMOS 6 MESES, mes a mes, vs lo que pagan hoy los
// operadores (TWAP 8am-10pm). Misma receta exacta que la estrategia viva.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zscore } from '../src/indicators.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PX = JSON.parse(readFileSync(path.join(HERE, 'usdmxn-1h-2y.json'), 'utf8'));
const TZ = 'America/Mexico_City';
const SINCE = new Date(Date.now() - 183 * 86_400_000).toISOString().slice(0, 10);
const dParts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')) % 24 };
};
const seq = PX.map(b => ({ ...dParts(b.ts), p: b.p }));
const closes = seq.map(x => x.p);
const byDay = {}; for (const s of seq) (byDay[s.date] ??= []).push(s);
const full = new Set(Object.entries(byDay).filter(([d, a]) => a.length >= 20 && d >= SINCE).map(([d]) => d));
const opsAvg = {};
for (const d of full) { const xs = byDay[d].filter(r => r.h >= 8 && r.h < 22); if (xs.length >= 8) opsAvg[d] = xs.reduce((x, y) => x + y.p, 0) / xs.length; }
const zAt = i => { const h = closes.slice(Math.max(0, i - 24), i); return h.length < 12 ? null : zscore(h, closes[i]); };

// receta HÍBRIDO exacta (hora a hora)
const res = {};
let cur = null, remaining = 0, mxn = 0, usdt = 0, dips = 0;
const dipCount = {};
for (let i = 0; i < seq.length; i++) {
  const { date, h, p } = seq[i];
  if (!full.has(date) || !opsAvg[date]) continue;
  if (date !== cur) { if (cur && usdt > 0) { res[cur] = (opsAvg[cur] - mxn / usdt) * 100; dipCount[cur] = dips; } cur = date; remaining = 100; mxn = 0; usdt = 0; dips = 0; }
  const z = zAt(i); let amt = 0;
  if (h < 8) { if (z != null && z <= -2) { amt = Math.min(remaining, 20); dips++; } }
  else if (h < 22) {
    const left = 22 - h;
    if (left <= 1) amt = remaining;
    else if (left <= 3) amt = remaining / left;
    else if (z != null && z <= -2) { amt = Math.min(remaining, 20); dips++; }
    else if (z != null && z <= -1) { amt = Math.min(remaining, 10); dips++; }
    else if (z != null && z >= 1) amt = 0;
    else amt = Math.min(remaining, remaining / left * 0.4);
  }
  if (amt > 0.01) { mxn += amt; usdt += amt / p; remaining -= amt; }
}
if (cur && usdt > 0) { res[cur] = (opsAvg[cur] - mxn / usdt) * 100; dipCount[cur] = dips; }

const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const months = [...new Set(Object.keys(res).map(d => d.slice(0, 7)))].sort();
const usdtDay = 25_000_000 / 17.5;
console.log('=== HÍBRIDO últimos 6 meses (vs operadores 8-22h) · ' + Object.keys(res).length + ' días ===\n');
console.log('  mes       ¢/día    %días+   días   ~MXN/mes   dips/día');
let tot = 0;
for (const M of months) {
  const cs = Object.entries(res).filter(([d]) => d.startsWith(M)).map(([, c]) => c);
  const dp = Object.entries(dipCount).filter(([d]) => d.startsWith(M)).map(([, c]) => c);
  const m = avg(cs); const mxnMes = m / 100 * usdtDay * cs.length; tot += mxnMes;
  console.log('  ' + M + '  ' + (m >= 0 ? '+' : '') + m.toFixed(2).padStart(6) + '   ' + String(Math.round(cs.filter(c => c > 0).length / cs.length * 100)).padStart(4) + '%   ' + String(cs.length).padStart(4) + '   ' + ((mxnMes >= 0 ? '+$' : '-$') + Math.abs(Math.round(mxnMes)).toLocaleString('es-MX')).padStart(9) + '   ' + avg(dp).toFixed(1));
}
const all = Object.values(res);
console.log('\n  TOTAL 6m:  ' + (avg(all) >= 0 ? '+' : '') + avg(all).toFixed(3) + '¢/día · gana ' + Math.round(all.filter(c => c > 0).length / all.length * 100) + '% de días · peor ' + Math.min(...all).toFixed(1) + '¢ · mejor +' + Math.max(...all).toFixed(1) + '¢');
console.log('  ≈ ' + (tot >= 0 ? '+$' : '-$') + Math.abs(Math.round(tot)).toLocaleString('es-MX') + ' MXN en 6 meses (~' + (tot >= 0 ? '+$' : '-$') + Math.abs(Math.round(tot * 2)).toLocaleString('es-MX') + '/año)');
