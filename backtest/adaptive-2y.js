// Política ADAPTATIVA sobre 2 años: en vez de ventana fija, decide CUÁNDO comprar
// cada día según el momentum del precio (proxy determinista del cerebro de Opus):
//   z >= +1 (subiendo)  → compra fuerte YA (el día probablemente sube: adelanta)
//   z <= -1 (bajando)   → NO compres (difiere: más tarde estará más barato)
//   neutro              → ritmo lento
//   fin del día         → completa lo que falte (siempre gasta el 100%)
// + robustez trimestral, comparada con TWAP, ventanas fijas y la tarde.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bars = JSON.parse(readFileSync(path.join(HERE, 'usdmxn-1h-2y.json'), 'utf8'));
const TZ = 'America/Mexico_City';
const dParts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')) % 24 };
};

// secuencia horaria continua + días completos
const seq = bars.map(b => ({ ...dParts(b.ts), p: b.p }));
const byDay = {}; for (const s of seq) (byDay[s.date] ??= []).push(s);
const full = new Set(Object.entries(byDay).filter(([, a]) => a.length >= 20).map(([d]) => d));
const dayAvg = {}; for (const d of full) { const a = byDay[d]; dayAvg[d] = a.reduce((x, y) => x + y.p, 0) / a.length; }
const dayChg = {}; for (const d of full) { const a = byDay[d]; dayChg[d] = (a.at(-1).p - a[0].p) * 100; }

const zAt = i => {
  const h = seq.slice(Math.max(0, i - 24), i).map(x => x.p);
  if (h.length < 12) return null;
  const m = h.reduce((x, y) => x + y, 0) / h.length;
  const sd = Math.sqrt(h.reduce((x, y) => x + (y - m) ** 2, 0) / (h.length - 1));
  return sd ? (seq[i].p - m) / sd : 0;
};

// política adaptativa parametrizable
function simAdaptive({ zUp = 1, zDn = -1, strongChunk = 20, upChunk = 10, neutralPace = 0.4 }) {
  const res = {};
  let cur = null, remaining = 0, mxn = 0, usdt = 0, idxInDay = 0, hoursInDay = 0;
  for (let i = 0; i < seq.length; i++) {
    const { date, p } = seq[i];
    if (!full.has(date)) continue;
    if (date !== cur) {
      if (cur && usdt > 0) res[cur] = (dayAvg[cur] - mxn / usdt) * 100;
      cur = date; remaining = 100; mxn = 0; usdt = 0; idxInDay = 0; hoursInDay = byDay[date].length;
    }
    idxInDay++;
    const left = hoursInDay - idxInDay + 1;
    const z = zAt(i);
    let amt = 0;
    if (left <= 1) amt = remaining;                                   // última hora: completa
    else if (left <= 3) amt = remaining / left;                       // recta final: parejo
    else if (z != null && z >= zUp) amt = Math.min(remaining, z >= zUp + 1 ? strongChunk : upChunk);  // subiendo: adelanta
    else if (z != null && z <= zDn) amt = 0;                          // bajando: difiere
    else amt = Math.min(remaining, remaining / left * neutralPace);   // neutro: lento
    if (amt > 0.01) { mxn += amt; usdt += amt / p; remaining -= amt; }
  }
  if (cur && usdt > 0) res[cur] = (dayAvg[cur] - mxn / usdt) * 100;
  return res;
}
// inversa: comprar cuando BAJA (reversión), diferir cuando sube
function simReversion() {
  return simAdaptive({ zUp: 99, zDn: 99 }); // no usada; placeholder
}

const qOf = d => d.slice(0, 4) + 'Q' + Math.ceil(Number(d.slice(5, 7)) / 3);
const summarize = (name, res) => {
  const cs = Object.values(res); const m = cs.reduce((x, y) => x + y, 0) / cs.length;
  const up = Object.entries(res).filter(([d]) => dayChg[d] > 1).map(([, c]) => c);
  const dn = Object.entries(res).filter(([d]) => dayChg[d] < -1).map(([, c]) => c);
  const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  console.log('  ' + name.padEnd(26) + (m >= 0 ? '+' : '') + m.toFixed(3) + '¢/día · gana ' + Math.round(cs.filter(c => c > 0).length / cs.length * 100) + '% · peor ' + Math.min(...cs).toFixed(1) + ' · días↑ ' + (avg(up) >= 0 ? '+' : '') + avg(up).toFixed(2) + ' · días↓ ' + (avg(dn) >= 0 ? '+' : '') + avg(dn).toFixed(2));
  return res;
};

console.log('=== POLÍTICA ADAPTATIVA (2 años, ' + full.size + ' días) — vs TWAP del día ===');
const A = summarize('Adaptativa (sigue momentum)', simAdaptive({}));
summarize('Adaptativa agresiva', simAdaptive({ strongChunk: 30, upChunk: 15 }));
summarize('Adaptativa conservadora', simAdaptive({ zUp: 1.5, zDn: -0.5, neutralPace: 0.7 }));

// variante INVERSA (compra debilidad, difiere fuerza) para descartar/espejo
function simDip({ zBuy = -1, chunk = 10, strongChunk = 20, neutralPace = 0.4 }) {
  const res = {};
  let cur = null, remaining = 0, mxn = 0, usdt = 0, idxInDay = 0, hoursInDay = 0;
  for (let i = 0; i < seq.length; i++) {
    const { date, p } = seq[i];
    if (!full.has(date)) continue;
    if (date !== cur) { if (cur && usdt > 0) res[cur] = (dayAvg[cur] - mxn / usdt) * 100; cur = date; remaining = 100; mxn = 0; usdt = 0; idxInDay = 0; hoursInDay = byDay[date].length; }
    idxInDay++;
    const left = hoursInDay - idxInDay + 1; const z = zAt(i); let amt = 0;
    if (left <= 1) amt = remaining;
    else if (left <= 3) amt = remaining / left;
    else if (z != null && z <= zBuy) amt = Math.min(remaining, z <= zBuy - 1 ? strongChunk : chunk);
    else if (z != null && z >= 1) amt = 0;
    else amt = Math.min(remaining, remaining / left * neutralPace);
    if (amt > 0.01) { mxn += amt; usdt += amt / p; remaining -= amt; }
  }
  if (cur && usdt > 0) res[cur] = (dayAvg[cur] - mxn / usdt) * 100;
  return res;
}
const D = summarize('Reversión (compra dips)', simDip({}));

console.log('\n=== ROBUSTEZ TRIMESTRAL ===');
console.log('  trimestre   Adaptativa   Reversión   Tarde12-18');
const tarde = {};
for (const d of full) { const xs = byDay[d].filter(r => r.h >= 12 && r.h < 18); if (xs.length >= 2) tarde[d] = (dayAvg[d] - xs.reduce((x, y) => x + y.p, 0) / xs.length) * 100; }
const qs = [...new Set([...full].map(qOf))].sort();
for (const Q of qs) {
  const line = [Q.padEnd(10)];
  for (const res of [A, D, tarde]) {
    const cs = Object.entries(res).filter(([d]) => qOf(d) === Q).map(([, c]) => c);
    const m = cs.reduce((x, y) => x + y, 0) / (cs.length || 1);
    line.push(((m >= 0 ? '+' : '') + m.toFixed(2)).padStart(10));
  }
  console.log('  ' + line.join('  '));
}
const usdtDay = 25_000_000 / 17.5;
const mA = Object.values(A).reduce((x, y) => x + y, 0) / Object.values(A).length;
console.log('\n  → Adaptativa a $25M/día ≈ ' + (mA >= 0 ? '+' : '') + Math.round(mA / 100 * usdtDay * 250).toLocaleString('es-MX') + ' MXN/año');
