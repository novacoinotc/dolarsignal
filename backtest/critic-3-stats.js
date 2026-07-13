// ATAQUE 3: multiplicidad / significancia. Bootstrap de dias, splits alternativos,
// error estandar, y ¿+0.25 se distingue de ruido tras miles de pruebas?
import { makeREV, makeREVreal, FULL, opsAvg, trendK, stats } from './critic-lib.js';

const OPS = Object.fromEntries(FULL.filter(d => opsAvg[d]).map(d => [d, 0]));
const REV = makeREV(), RL = makeREVreal(0.5);
const T = 5, lb = 1;
// serie diaria del ganador
const daily = {};
for (const d of Object.keys(REV)) { const t = trendK(d, lb); if (t == null) continue; const eng = t > T ? OPS : t < -T ? REV : RL; const v = eng?.[d]; if (v != null) daily[d] = v; }
const days = Object.keys(daily).sort();
const vals = days.map(d => daily[d]);
const n = vals.length;
const mean = vals.reduce((a, b) => a + b, 0) / n;
const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
const se = sd / Math.sqrt(n);
console.log('n dias:', n, '| media', mean.toFixed(3), '| sd', sd.toFixed(2), '| SE', se.toFixed(3), '| t-stat', (mean / se).toFixed(2));
console.log('IC95% naive: [', (mean - 1.96 * se).toFixed(3), ',', (mean + 1.96 * se).toFixed(3), ']');

// Bootstrap por dia (10k) sobre TODA la muestra
function boot(arr, B = 10000) {
  const m = arr.length, out = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let k = 0; k < m; k++) s += arr[(Math.random() * m) | 0]; out.push(s / m); }
  out.sort((a, b) => a - b);
  return out;
}
const bAll = boot(vals);
console.log('Bootstrap all  IC95%: [', bAll[250].toFixed(3), ',', bAll[9750].toFixed(3), '] | P(media<=0):', (bAll.filter(x => x <= 0).length / bAll.length).toFixed(4));
// bootstrap solo val 2026
const valDays = days.filter(d => d >= '2026-01-01').map(d => daily[d]);
const bVal = boot(valDays);
console.log('Bootstrap 2026 IC95%: [', bVal[250].toFixed(3), ',', bVal[9750].toFixed(3), '] | n', valDays.length, '| P(<=0):', (bVal.filter(x => x <= 0).length / bVal.length).toFixed(4));

// Multiplicidad: con miles de politicas iid ruido de SE~se, el MAXIMO esperado sube.
// aprox: E[max de M normales] ~ se*sqrt(2 ln M). Ronda1 ~2700 + ronda2 48.
for (const M of [48, 2700, 2748]) {
  const emax = se * Math.sqrt(2 * Math.log(M));
  console.log('  Con M=' + M + ' pruebas, edge esperado por PURO AZAR del mejor ~', emax.toFixed(3), '¢ (SE=' + se.toFixed(3) + ')');
}

// Splits alternativos: pares/impares, y por trimestre (rotando cual es "val")
console.log('\n=== Splits alternativos train/val (mismo ganador T5 lb1) ===');
const even = days.filter((_, i) => i % 2 === 0).map(d => daily[d]);
const odd = days.filter((_, i) => i % 2 === 1).map(d => daily[d]);
const av = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log('  pares', av(even).toFixed(3), '| impares', av(odd).toFixed(3));
// por trimestre
const q = {};
for (const d of days) { const [y, m] = d.split('-').map(Number); const key = y + 'Q' + (Math.ceil(m / 3)); (q[key] ??= []).push(daily[d]); }
for (const k of Object.keys(q).sort()) console.log('  ' + k + ':', av(q[k]).toFixed(3), '(n=' + q[k].length + ')');
