// ATAQUE 5 y 6: realismo de ejecucion + de donde viene el edge.
// - costo de spread RFQ, - completado forzoso 22h, - fills de madrugada (h<8),
// - descomposicion por regimen del switcher, - por vol realizada.
import { seq, Z, byDay, fullSet, run, makeREV, makeREVreal, FULL, opsAvg, dayChg, trendK, stats } from './critic-lib.js';

const OPS = Object.fromEntries(FULL.filter(d => opsAvg[d]).map(d => [d, 0]));
const T = 5, lb = 1;

// Reconstruir el ganador PERO instrumentando cada fill (hora, forzoso).
// engine=REV en dias tras-baja, REVLIGHT(real) en planos, OPS(nada) tras-alza.
function regimeOf(d) { const t = trendK(d, lb); if (t == null) return null; return t > T ? 'up' : t < -T ? 'dn' : 'flat'; }

// corrida instrumentada: replica REV (dn) y REVLIGHT-real (flat), OPS (up)
let fillsByHour = {}, totMxn = 0, nightMxn = 0, forcedMxn = 0;
const decideFor = (reg) => (i, h, rem) => {
  if (reg === 'up') { const left = h >= 21 ? 1 : (22 - h); return h >= 21 ? rem : (h < 8 || h >= 22 ? 0 : rem / left * 1); } // OPS ~ parejo diurno
  const scale = reg === 'flat' ? 0.5 : 1;
  const z = Z[i];
  if (h < 8) return (z != null && z <= -2) ? 30 * scale : 0;
  if (h >= 22) return 0;
  const left = 22 - h; if (left <= 3) return rem / left;
  if (z != null && z <= -2) return 30 * scale;
  if (z != null && z <= -1) return 10 * scale;
  if (z != null && z >= 1.5) return 0;
  return rem / left * (reg === 'flat' ? 0.75 : 0.5);
};

// simulador manual por dia para contabilizar horas de fill
function simDay(dayIdx, reg) {
  let rem = 100, mxn = 0, usdt = 0; const fills = [];
  for (const i of dayIdx) {
    const { h, p } = seq[i];
    let amt = decideFor(reg)(i, h, rem);
    let forced = false;
    if (h >= 21 && rem > 0.01) { amt = rem; forced = true; }
    if (amt > 0.01) { const a = Math.min(amt, rem); mxn += a; usdt += a / p; rem -= a; fills.push({ h, a, forced }); }
  }
  return { avgPx: usdt > 0 ? mxn / usdt : null, fills };
}

const perDay = {};
for (const d of FULL) {
  if (!opsAvg[d]) continue; const reg = regimeOf(d); if (!reg) continue;
  const { avgPx, fills } = simDay(byDay[d], reg);
  if (avgPx == null) continue;
  perDay[d] = (opsAvg[d] - avgPx) * 100;
  for (const f of fills) { fillsByHour[f.h] = (fillsByHour[f.h] || 0) + f.a; totMxn += f.a; if (f.h < 8) nightMxn += f.a; if (f.forced) forcedMxn += f.a; }
}
const s = stats(perDay);
console.log('Ganador reconstruido instrumentado: train', s.train.toFixed(3), 'val', s.val.toFixed(3));
console.log('% del volumen comprado en MADRUGADA (h<8):', (100 * nightMxn / totMxn).toFixed(1) + '%');
console.log('% del volumen comprado FORZOSO (>=21h):', (100 * forcedMxn / totMxn).toFixed(1) + '%');

// ¿Cuanto del edge vive en dias que completan forzoso mucho? split por fraccion forzosa
// (rehacer con flag). Aqui: edge medio en dias tras-baja (REV) vs planos vs alza.
const buckets = { up: [], dn: [], flat: [] };
for (const d of Object.keys(perDay)) buckets[regimeOf(d)].push(perDay[d]);
const av = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
console.log('\nEdge medio por regimen: tras-BAJA(REV)', av(buckets.dn).toFixed(3), '(n' + buckets.dn.length + ') | PLANO(revlight)', av(buckets.flat).toFixed(3), '(n' + buckets.flat.length + ') | tras-ALZA(ops~0)', av(buckets.up).toFixed(3), '(n' + buckets.up.length + ')');

// ATAQUE 5: costo de spread. resta c¢ por dia (encarece compra). ¿breakeven?
console.log('\n=== Sensibilidad a costo de spread (¢/dia restados) ===');
for (const c of [0, 0.5, 1, 1.5, 2]) {
  const r2 = {}; for (const d of Object.keys(perDay)) r2[d] = perDay[d] - c;
  const s2 = stats(r2);
  console.log('  spread ' + c + '¢: train', s2.train.toFixed(3), 'val', s2.val.toFixed(3));
}
// NOTA: si el benchmark TWAP tambien paga spread, el spread se cancela parcialmente.
// El costo NETO es el spread EXTRA por concentrar compras en dips/madrugada (menos liquidez).

// ATAQUE 6: por vol realizada del dia (rango intradia en ¢)
console.log('\n=== Edge por VOLATILIDAD del dia (rango hi-lo intradia, ¢) ===');
const rng = {};
for (const d of FULL) { const a = byDay[d].map(i => seq[i].p); rng[d] = (Math.max(...a) - Math.min(...a)) * 100; }
const withR = Object.keys(perDay).map(d => ({ d, e: perDay[d], r: rng[d] })).sort((a, b) => a.r - b.r);
const q = Math.floor(withR.length / 4);
for (let k = 0; k < 4; k++) { const sl = withR.slice(k * q, k === 3 ? withR.length : (k + 1) * q); console.log('  Q' + (k + 1) + ' vol[' + sl[0].r.toFixed(1) + '-' + sl.at(-1).r.toFixed(1) + '¢]: edge', av(sl.map(x => x.e)).toFixed(3), '(n' + sl.length + ')'); }
