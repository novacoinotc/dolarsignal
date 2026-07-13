// ATAQUE 7 (datos) + atribucion fina del edge a la madrugada + t-stat del bet real.
import { seq, byDay, Z, run, makeREV, makeREVreal, FULL, opsAvg, dayChg, trendK, stats, N } from './critic-lib.js';

// --- DATOS: barras por dia, huecos, findes, timezone ---
const counts = FULL.map(d => byDay[d].length);
const allDays = Object.keys(byDay).sort();
console.log('=== DATOS ===');
console.log('dias totales con datos:', allDays.length, '| dias FULL (>=20 barras):', FULL.length);
console.log('barras/dia FULL: min', Math.min(...counts), 'max', Math.max(...counts), 'media', (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1));
// huecos temporales > 2h dentro de la serie
let gaps = 0, maxGap = 0;
for (let i = 1; i < N; i++) { const dt = (seq[i].ts - seq[i - 1].ts) / 3.6e6; if (dt > 2.5) { gaps++; maxGap = Math.max(maxGap, dt); } }
console.log('huecos >2.5h:', gaps, '| hueco maximo (h):', maxGap.toFixed(1));
// dia de semana de los dias FULL (0=dom)
const dow = {};
for (const d of FULL) { const wd = new Date(d + 'T12:00:00Z').getUTCDay(); dow[wd] = (dow[wd] || 0) + 1; }
console.log('dias FULL por dia-de-semana (0=dom..6=sab):', JSON.stringify(dow));

// --- ATRIBUCION: edge con vs sin fills de madrugada (h<8) ---
const OPS = Object.fromEntries(FULL.filter(d => opsAvg[d]).map(d => [d, 0]));
const T = 5, lb = 1;
function switcherEdge(nightOn) {
  const REV = run((i, h, rem) => {
    const z = Z[i];
    if (h < 8) return (nightOn && z != null && z <= -2) ? 30 : 0;
    if (h >= 22) return 0;
    const left = 22 - h; if (left <= 3) return rem / left;
    if (z != null && z <= -2) return 30;
    if (z != null && z <= -1) return 10;
    if (z != null && z >= 1.5) return 0;
    return rem / left * 0.5;
  }).res;
  const RL = run((i, h, rem) => {
    const z = Z[i];
    if (h < 8) return (nightOn && z != null && z <= -2) ? 15 : 0;
    if (h >= 22) return 0;
    const left = 22 - h; if (left <= 3) return rem / left;
    if (z != null && z <= -2) return 15;
    if (z != null && z <= -1) return 5;
    if (z != null && z >= 1.5) return 0;
    return rem / left * 0.75;
  }).res;
  const res = {};
  for (const d of Object.keys(REV)) { const t = trendK(d, lb); if (t == null) continue; const eng = t > T ? OPS : t < -T ? REV : RL; const v = eng?.[d]; if (v != null) res[d] = v; }
  return { res, s: stats(res) };
}
const on = switcherEdge(true), off = switcherEdge(false);
console.log('\n=== ATRIBUCION MADRUGADA ===');
console.log('con fills madrugada:  train', on.s.train.toFixed(3), 'val', on.s.val.toFixed(3));
console.log('sin fills madrugada:  train', off.s.train.toFixed(3), 'val', off.s.val.toFixed(3));
console.log('=> edge que DEPENDE de comprar 30% a z<=-2 en madrugada (h<8):',
  (on.s.all - off.s.all).toFixed(3), '¢/dia de', on.s.all.toFixed(3), '(', (100 * (on.s.all - off.s.all) / on.s.all).toFixed(0) + '% del total)');

// --- t-stat del BET REAL: solo los dias tras-baja (donde vive el edge) ---
const REV = makeREV();
const dnDays = [];
for (const d of Object.keys(REV)) { const t = trendK(d, lb); if (t == null) continue; if (t < -T) dnDays.push(REV[d]); }
const m = dnDays.reduce((a, b) => a + b, 0) / dnDays.length;
const sd = Math.sqrt(dnDays.reduce((a, b) => a + (b - m) ** 2, 0) / (dnDays.length - 1));
console.log('\n=== EL BET REAL (dias tras-baja, motor REV) ===');
console.log('n', dnDays.length, '| media', m.toFixed(3), '| sd', sd.toFixed(2), '| SE', (sd / Math.sqrt(dnDays.length)).toFixed(3), '| t-stat', (m / (sd / Math.sqrt(dnDays.length))).toFixed(2));
