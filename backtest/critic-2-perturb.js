// ATAQUE 2: fragilidad parametrica. Perturba T, lb, y params del motor REV ±1 paso.
// ¿meseta o pico?
import { makeREV, makeMOM, makeREVreal, FULL, opsAvg, trendK, stats } from './critic-lib.js';

const MOM = makeMOM();
const OPS = Object.fromEntries(FULL.filter(d => opsAvg[d]).map(d => [d, 0]));

function switcher(REV, REVLIGHT, T, lb) {
  const res = {};
  for (const d of Object.keys(REV)) { const t = trendK(d, lb); if (t == null) continue; const eng = t > T ? OPS : t < -T ? REV : REVLIGHT; const v = eng?.[d]; if (v != null) res[d] = v; }
  return stats(res);
}
const REV0 = makeREV();
const RL0 = makeREVreal(0.5);

console.log('=== Perturbar T (con lb=1, REV base) ===');
for (const T of [3, 4, 5, 6, 7]) { const s = switcher(REV0, RL0, T, 1); console.log('  T=' + T, 'train', s.train.toFixed(3), 'val', s.val.toFixed(3), 'worst', s.worst.toFixed(1)); }
console.log('=== Perturbar lookback (T=5) ===');
for (const lb of [1, 2, 3]) { const s = switcher(REV0, RL0, 5, lb); console.log('  lb=' + lb, 'train', s.train.toFixed(3), 'val', s.val.toFixed(3), 'worst', s.worst.toFixed(1)); }

console.log('\n=== Perturbar motor REV (T=5 lb=1), un paso a la vez ===');
const base = { zS: -2, zD: -1, cS: 30, cD: 10, defer: 1.5, pace: 0.5, night: 'strong' };
const grid = {
  zS: [-2.5, -2, -1.5], zD: [-1.5, -1, -0.75], cS: [20, 30, 40], cD: [6, 10, 15],
  defer: [1, 1.5, null], pace: [0.3, 0.5, 0.7], night: ['off', 'strong'],
};
const b = switcher(REV0, RL0, 5, 1);
console.log('  BASE                     train', b.train.toFixed(3), 'val', b.val.toFixed(3), 'worst', b.worst.toFixed(1));
for (const k of Object.keys(grid)) for (const v of grid[k]) {
  if (v === base[k]) continue;
  const rev = makeREV({ ...base, [k]: v });
  const rl = makeREVreal(0.5); // REVLIGHT no depende del param perturbado (aprox) — solo movemos REV
  const s = switcher(rev, rl, 5, 1);
  const flag = (s.val < 0.15 ? '  <-- se cae' : '');
  console.log('  ' + (k + '=' + v).padEnd(24), 'train', s.train.toFixed(3), 'val', s.val.toFixed(3), 'worst', s.worst.toFixed(1) + flag);
}
