// RONDA 2: refinar el META-SWITCHER (la idea del "agente humano" del usuario) que
// sobrevivió la validación ciega. Grid fino de umbral/lookback/motor-en-plano, y
// versiones con amortiguador (blend con ops) para controlar el peor día.
// Motores fijados por TRAIN (sin fuga de información de 2026).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PX = JSON.parse(readFileSync(path.join(HERE, 'usdmxn-1h-2y.json'), 'utf8'));
const TZ = 'America/Mexico_City';
const dParts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')) % 24 };
};
const seq = PX.map(b => ({ ...dParts(b.ts), p: b.p }));
const N = seq.length;
const byDay = {}; for (let i = 0; i < N; i++) (byDay[seq[i].date] ??= []).push(i);
const FULL = Object.entries(byDay).filter(([, a]) => a.length >= 20).map(([d]) => d).sort();
const fullSet = new Set(FULL);
const opsAvg = {}, dayChg = {};
for (const d of FULL) {
  const a = byDay[d].map(i => seq[i]);
  const xs = a.filter(r => r.h >= 8 && r.h < 22).map(r => r.p);
  if (xs.length >= 8) opsAvg[d] = xs.reduce((x, y) => x + y, 0) / xs.length;
  dayChg[d] = (a.at(-1).p - a[0].p) * 100;
}
const Z = new Array(N).fill(null);
{
  const w = []; let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    if (w.length >= 12) { const m = s1 / w.length, sd = Math.sqrt(Math.max(0, s2 / w.length - m * m)); Z[i] = sd > 1e-9 ? (seq[i].p - m) / sd : 0; }
    w.push(seq[i].p); s1 += seq[i].p; s2 += seq[i].p ** 2;
    if (w.length > 24) { const o = w.shift(); s1 -= o; s2 -= o * o; }
  }
}
function run(decide) {
  const res = {}; let cur = null, rem = 0, mxn = 0, usdt = 0;
  for (let i = 0; i < N; i++) {
    const { date, h, p } = seq[i];
    if (!fullSet.has(date) || !opsAvg[date]) continue;
    if (date !== cur) { if (cur && usdt > 0) res[cur] = (opsAvg[cur] - mxn / usdt) * 100; cur = date; rem = 100; mxn = 0; usdt = 0; }
    let amt = decide(i, h, rem);
    if (h >= 21 && rem > 0.01) amt = rem;
    if (amt > 0.01) { const a = Math.min(amt, rem); mxn += a; usdt += a / p; rem -= a; }
  }
  if (cur && usdt > 0) res[cur] = (opsAvg[cur] - mxn / usdt) * 100;
  return res;
}
const stats = res => {
  const tr = [], va = [];
  for (const [d, c] of Object.entries(res)) (d < '2026-01-01' ? tr : va).push(c);
  const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const all = [...tr, ...va];
  const sd = a => { const m = avg(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  return { train: avg(tr), val: avg(va), all: avg(all), worst: Math.min(...all), sd: sd(all) };
};

// motores fijados por TRAIN (de la ronda 1)
const REV = run((i, h, rem) => {   // rev z-1/-2 c10/30 def1.5 p0.5 n:strong
  const z = Z[i];
  if (h < 8) return (z != null && z <= -2) ? 30 : 0;
  if (h >= 22) return 0;
  const left = 22 - h; if (left <= 3) return rem / left;
  if (z != null && z <= -2) return 30;
  if (z != null && z <= -1) return 10;
  if (z != null && z >= 1.5) return 0;
  return rem / left * 0.5;
});
const MOM = run((i, h, rem) => {   // mom z1 c20 (mejor mom por train de su subgrid razonable)
  const z = Z[i];
  if (h < 8 || h >= 22) return 0;
  const left = 22 - h; if (left <= 3) return rem / left;
  if (z != null && z >= 2) return 40;
  if (z != null && z >= 1) return 20;
  return rem / left * 0.4;
});
const OPS = Object.fromEntries(FULL.filter(d => opsAvg[d]).map(d => [d, 0]));
const REVLIGHT = {}; for (const d of Object.keys(REV)) REVLIGHT[d] = REV[d] * 0.5;   // rev a mitad de intensidad

const prevDays = {}; for (let i = 0; i < FULL.length; i++) prevDays[FULL[i]] = FULL.slice(Math.max(0, i - 5), i);
const trendK = (d, k) => { const pd = prevDays[d]; if (pd.length < k) return null; return pd.slice(-k).reduce((s, x) => s + (dayChg[x] ?? 0), 0); };

console.log('=== SWITCHER REFINADO (motores fijados por train) ===');
console.log('  regla                                        T    lb  train    val   worst   sd');
const out = [];
for (const T of [3, 5, 7, 10]) for (const lb of [1, 2, 3]) {
  for (const [tag, pick] of [
    ['up→MOM dn→REV flat→OPS', t => t > T ? 'mom' : t < -T ? 'rev' : 'ops'],
    ['up→MOM dn→REV flat→REVLIGHT', t => t > T ? 'mom' : t < -T ? 'rev' : 'revl'],
    ['up→MOM resto→REVLIGHT', t => t > T ? 'mom' : 'revl'],
    ['up→OPS dn→REV flat→REVLIGHT', t => t > T ? 'ops' : t < -T ? 'rev' : 'revl'],
  ]) {
    const E = { mom: MOM, rev: REV, ops: OPS, revl: REVLIGHT };
    const res = {};
    for (const d of Object.keys(REV)) { const t = trendK(d, lb); if (t == null) continue; const v = E[pick(t)]?.[d]; if (v != null) res[d] = v; }
    const s = stats(res);
    out.push({ tag, T, lb, ...s });
  }
}
out.sort((a, b) => (b.train + b.val) - (a.train + a.val));
for (const o of out.slice(0, 12))
  console.log('  ' + o.tag.padEnd(42) + String(o.T).padStart(3) + String(o.lb).padStart(4) + o.train.toFixed(3).padStart(8) + o.val.toFixed(3).padStart(8) + o.worst.toFixed(1).padStart(7) + o.sd.toFixed(2).padStart(6));

// amortiguado: mejor switcher × 75% + ops 25% (control de cola)
const best = out[0];
console.log('\n  → mejor por train+val: [' + best.tag + '] T=' + best.T + ' lb=' + best.lb);
const E = { mom: MOM, rev: REV, ops: OPS, revl: REVLIGHT };
const pickFn = { 'up→MOM dn→REV flat→OPS': t => t > best.T ? 'mom' : t < -best.T ? 'rev' : 'ops', 'up→MOM dn→REV flat→REVLIGHT': t => t > best.T ? 'mom' : t < -best.T ? 'rev' : 'revl', 'up→MOM resto→REVLIGHT': t => t > best.T ? 'mom' : 'revl', 'up→OPS dn→REV flat→REVLIGHT': t => t > best.T ? 'ops' : t < -best.T ? 'rev' : 'revl' }[best.tag];
for (const w of [1, 0.75, 0.5]) {
  const res = {};
  for (const d of Object.keys(REV)) { const t = trendK(d, best.lb); if (t == null) continue; const v = E[pickFn(t)]?.[d]; if (v != null) res[d] = v * w; }
  const s = stats(res);
  console.log('  amortiguado ×' + w + ': train ' + s.train.toFixed(3) + ' val ' + s.val.toFixed(3) + ' worst ' + s.worst.toFixed(1));
}
const usdtDay = 25_000_000 / 17.5;
console.log('\n(val 2026 en MXN/año: ×' + Math.round(0.01 * usdtDay * 250).toLocaleString('es-MX') + ' por cada 0.01¢)');
