// Backtest 2 AÑOS contra la OPERACIÓN REAL:
//   Benchmark = lo que hacen HOY los 10 operadores: refondear parejo 8am-10pm.
//   Bot = colchón de $25M (libertad de día completo) comprando con reversión.
// Descompone el edge: (a) solo libertad de horario, (b) solo habilidad (dips),
// (c) ambas, (d) híbrido: dips normales 8-22 + madrugada SOLO en dips fuertes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zscore } from '../src/indicators.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PX = JSON.parse(readFileSync(path.join(HERE, 'usdmxn-1h-2y.json'), 'utf8'));
const TZ = 'America/Mexico_City';
const dParts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')) % 24 };
};

const seq = PX.map(b => ({ ...dParts(b.ts), p: b.p }));
const closes = seq.map(x => x.p);
const byDay = {}; for (const s of seq) (byDay[s.date] ??= []).push(s);
const full = new Set(Object.entries(byDay).filter(([, a]) => a.length >= 20).map(([d]) => d));

// BENCHMARK: promedio 8am-10pm (refondeo actual de los operadores)
const opsAvg = {};
for (const d of full) {
  const xs = byDay[d].filter(r => r.h >= 8 && r.h < 22);
  if (xs.length >= 8) opsAvg[d] = xs.reduce((x, y) => x + y.p, 0) / xs.length;
}
const dayChg = {}; for (const d of full) { const a = byDay[d]; dayChg[d] = (a.at(-1).p - a[0].p) * 100; }

const zAt = i => {
  const h = closes.slice(Math.max(0, i - 24), i);
  if (h.length < 12) return null;
  return zscore(h, closes[i]);
};

// simulador genérico: hourWindow = [ini, fin) de compra; nightDips = comprar 0-8h solo si z<=-2
function sim({ w0 = 0, w1 = 24, nightStrongOnly = false, skill = true }) {
  const res = {};
  let cur = null, remaining = 0, mxn = 0, usdt = 0;
  const idxOfDay = {};
  for (let i = 0; i < seq.length; i++) {
    const { date, h, p } = seq[i];
    if (!full.has(date) || !opsAvg[date]) continue;
    if (date !== cur) { if (cur && usdt > 0) res[cur] = (opsAvg[cur] - mxn / usdt) * 100; cur = date; remaining = 100; mxn = 0; usdt = 0; }
    const inMain = h >= w0 && h < w1;
    const inNight = nightStrongOnly && h < 8;
    if (!inMain && !inNight) { if (h >= w1 && remaining > 0.01) { mxn += remaining; usdt += remaining / p; remaining = 0; } continue; }
    const hoursLeft = Math.max(1, w1 - Math.max(h, w0));
    const z = skill ? zAt(i) : null;
    let amt = 0;
    if (inNight && !inMain) {                       // madrugada: SOLO dips fuertes
      if (z != null && z <= -2) amt = Math.min(remaining, 20);
    } else if (!skill) {                            // sin habilidad: parejo
      amt = remaining / hoursLeft;
    } else if (hoursLeft <= 1) amt = remaining;
    else if (hoursLeft <= 3) amt = remaining / hoursLeft;
    else if (z != null && z <= -2) amt = Math.min(remaining, 20);
    else if (z != null && z <= -1) amt = Math.min(remaining, 10);
    else if (z != null && z >= 1) amt = 0;
    else amt = Math.min(remaining, remaining / hoursLeft * 0.4);
    if (amt > 0.01) { mxn += amt; usdt += amt / p; remaining -= amt; }
  }
  if (cur && usdt > 0) res[cur] = (opsAvg[cur] - mxn / usdt) * 100;
  return res;
}

const variants = {
  'Solo libertad (TWAP 24h)':       sim({ skill: false }),
  'Solo habilidad (dips 8-22)':     sim({ w0: 8, w1: 22 }),
  'Libertad+habilidad (dips 24h)':  sim({ w0: 0, w1: 24 }),
  'Híbrido (dips 8-22 + noche z<=-2)': sim({ w0: 8, w1: 22, nightStrongOnly: true }),
};

const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const qOf = d => d.slice(0, 4) + 'Q' + Math.ceil(Number(d.slice(5, 7)) / 3);
console.log('=== vs LO QUE PAGAN HOY LOS OPERADORES (TWAP 8am-10pm) · 2 años, ' + Object.keys(opsAvg).length + ' días ===');
for (const [name, res] of Object.entries(variants)) {
  const cs = Object.values(res);
  const up = Object.entries(res).filter(([d]) => dayChg[d] > 1).map(([, c]) => c);
  const dn = Object.entries(res).filter(([d]) => dayChg[d] < -1).map(([, c]) => c);
  console.log('  ' + name.padEnd(35) + (avg(cs) >= 0 ? '+' : '') + avg(cs).toFixed(3) + '¢/día · gana ' + Math.round(cs.filter(c => c > 0).length / cs.length * 100) + '% · peor ' + Math.min(...cs).toFixed(1) + ' · ↑' + avg(up).toFixed(2) + ' ↓' + (avg(dn) >= 0 ? '+' : '') + avg(dn).toFixed(2));
}
console.log('\n=== ROBUSTEZ TRIMESTRAL (¢/día vs operadores) ===');
const names = Object.keys(variants);
console.log('  trim      ' + names.map(n => n.slice(0, 11).padStart(13)).join(''));
for (const Q of [...new Set(Object.keys(opsAvg).map(qOf))].sort()) {
  const line = [Q.padEnd(8)];
  for (const n of names) {
    const cs = Object.entries(variants[n]).filter(([d]) => qOf(d) === Q).map(([, c]) => c);
    line.push(((avg(cs) >= 0 ? '+' : '') + avg(cs).toFixed(2)).padStart(13));
  }
  console.log('  ' + line.join(''));
}
const usdtDay = 25_000_000 / 17.5;
console.log('');
for (const n of names) {
  const m = avg(Object.values(variants[n]));
  console.log('  → ' + n + ' ≈ ' + (m >= 0 ? '+' : '') + Math.round(m / 100 * usdtDay * 250).toLocaleString('es-MX') + ' MXN/año');
}
