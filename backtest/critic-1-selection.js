// ATAQUE 1: fuga de selección. switcher-refine.js ordena por (train+val).
// ¿El ganador cambia si eliges SOLO por train? ¿Y el REVLIGHT es trampa?
import { makeREV, makeMOM, makeREVreal, FULL, opsAvg, trendK, stats } from './critic-lib.js';

const REV = makeREV();
const MOM = makeMOM();
const OPS = Object.fromEntries(FULL.filter(d => opsAvg[d]).map(d => [d, 0]));
const REVLIGHT = {}; for (const d of Object.keys(REV)) REVLIGHT[d] = REV[d] * 0.5; // el FALSO
const E = { mom: MOM, rev: REV, ops: OPS, revl: REVLIGHT };

const rules = [
  ['up→MOM dn→REV flat→OPS', (t, T) => t > T ? 'mom' : t < -T ? 'rev' : 'ops'],
  ['up→MOM dn→REV flat→REVLIGHT', (t, T) => t > T ? 'mom' : t < -T ? 'rev' : 'revl'],
  ['up→MOM resto→REVLIGHT', (t, T) => t > T ? 'mom' : 'revl'],
  ['up→OPS dn→REV flat→REVLIGHT', (t, T) => t > T ? 'ops' : t < -T ? 'rev' : 'revl'],
];
const out = [];
for (const T of [3, 5, 7, 10]) for (const lb of [1, 2, 3]) for (const [tag, pick] of rules) {
  const res = {};
  for (const d of Object.keys(REV)) { const t = trendK(d, lb); if (t == null) continue; const v = E[pick(t, T)]?.[d]; if (v != null) res[d] = v; }
  out.push({ tag, T, lb, ...stats(res) });
}
const byTV = [...out].sort((a, b) => (b.train + b.val) - (a.train + a.val));
const byTR = [...out].sort((a, b) => b.train - a.train);
console.log('N politicas ronda-2:', out.length);
console.log('\nGanador por (train+val)  [el reportado]:', byTV[0].tag, 'T' + byTV[0].tag, 'T=' + byTV[0].T, 'lb=' + byTV[0].lb, '-> train', byTV[0].train.toFixed(3), 'val', byTV[0].val.toFixed(3));
console.log('Ganador por SOLO train   [honesto]     :', byTR[0].tag, 'T=' + byTR[0].T, 'lb=' + byTR[0].lb, '-> train', byTR[0].train.toFixed(3), 'val', byTR[0].val.toFixed(3));
console.log('\nTop-5 por SOLO train (val = out-of-sample real):');
for (const o of byTR.slice(0, 5)) console.log('  ' + o.tag.padEnd(30), 'T=' + o.T, 'lb=' + o.lb, 'train', o.train.toFixed(3), 'val', o.val.toFixed(3), 'worst', o.worst.toFixed(1));

// ¿Cuánto sube el val "elegido" vs el val promedio de todas las políticas? (optimismo de selección)
const avgVal = out.reduce((s, o) => s + o.val, 0) / out.length;
const maxVal = Math.max(...out.map(o => o.val));
console.log('\nval promedio de las', out.length, 'politicas:', avgVal.toFixed(3), '| val MAXIMO (si pescas el val):', maxVal.toFixed(3), '| val del ganador reportado:', byTV[0].val.toFixed(3));

// ATAQUE 4: REVLIGHT real vs falso. Reconstruye el ganador con REVLIGHT ejecutable.
console.log('\n=== ATAQUE 4: REVLIGHT falso (REV*0.5) vs REAL (chunks/pace a media intensidad) ===');
const REVLIGHT_real = makeREVreal(0.5);
const build = (revlEngine, T = 5, lb = 1) => {
  const res = {};
  for (const d of Object.keys(REV)) { const t = trendK(d, lb); if (t == null) continue; const eng = t > T ? OPS : t < -T ? REV : revlEngine; const v = eng?.[d]; if (v != null) res[d] = v; }
  return stats(res);
};
const sFalse = build(REVLIGHT);
const sReal = build(REVLIGHT_real);
console.log('Ganador con REVLIGHT FALSO (reportado): train', sFalse.train.toFixed(3), 'val', sFalse.val.toFixed(3), 'worst', sFalse.worst.toFixed(1));
console.log('Ganador con REVLIGHT REAL (ejecutable): train', sReal.train.toFixed(3), 'val', sReal.val.toFixed(3), 'worst', sReal.worst.toFixed(1));
// también REV puro real a mitad, para comparar el "×0.5" contable directo
const half = {}; for (const d of Object.keys(REV)) half[d] = REV[d] * 0.5;
console.log('REV*0.5 contable vs REV real-mitad (promedio dif ¢/dia):',
  (Object.keys(REV).reduce((s, d) => s + (half[d] - REVLIGHT_real[d]), 0) / Object.keys(REV).length).toFixed(4));
