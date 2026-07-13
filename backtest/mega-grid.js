// MEGA-GRID: harness unificado que barre miles de combinaciones de políticas sobre
// 2 años, con WALK-FORWARD (train: jul24-dic25 / validación ciega: 2026).
// Familias: REVERSIÓN (±diferir, ±noche), CRASH-DIP (patrón manual del usuario:
// caída brusca que estabiliza → compra fuerte), MOMENTUM, MEZCLAS fijas, y
// META-SWITCHER (elige motor por régimen del día previo). Métrica de negocio:
// ¢/día vs lo que pagan los operadores hoy (TWAP 8am-10pm). Todo determinista.
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

// ── preparación ──
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
// z-score precomputado (24h) y máximos recientes para crash-dip
const Z = new Array(N).fill(null);
{
  const w = []; let sum = 0, sum2 = 0;
  for (let i = 0; i < N; i++) {
    if (w.length >= 12) {
      const m = sum / w.length, sd = Math.sqrt(Math.max(0, sum2 / w.length - m * m));
      Z[i] = sd > 1e-9 ? (seq[i].p - m) / sd : 0;
    }
    w.push(seq[i].p); sum += seq[i].p; sum2 += seq[i].p ** 2;
    if (w.length > 24) { const o = w.shift(); sum -= o; sum2 -= o * o; }
  }
}
const maxPrev = (i, H) => { let m = -Infinity; for (let k = Math.max(0, i - H); k < i; k++) m = Math.max(m, seq[k].p); return m; };

// ── simulador core: recibe fn de decisión por barra, devuelve ¢/día vs operadores ──
function run(decide) {
  const res = {};
  let cur = null, rem = 0, mxn = 0, usdt = 0, state = {};
  for (let i = 0; i < N; i++) {
    const { date, h, p } = seq[i];
    if (!fullSet.has(date) || !opsAvg[date]) continue;
    if (date !== cur) { if (cur && usdt > 0) res[cur] = (opsAvg[cur] - mxn / usdt) * 100; cur = date; rem = 100; mxn = 0; usdt = 0; state = {}; }
    let amt = decide(i, h, rem, state);
    if (h >= 21 && rem > 0.01) amt = rem;              // cierre 10pm: completa SIEMPRE
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
  return { train: avg(tr), val: avg(va), all: avg(all), win: all.filter(c => c > 0).length / all.length * 100, worst: Math.min(...all) };
};

// ── FAMILIAS ──
const results = [];
const add = (name, fam, res) => results.push({ name, fam, res, ...stats(res) });

// 1) REVERSIÓN: zDip/zStrong/chunks/defer/pace/noche
for (const zD of [-0.75, -1, -1.5]) for (const zS of [-2, -2.5])
for (const cD of [6, 10, 15]) for (const cS of [20, 30])
for (const defer of [null, 1, 1.5]) for (const pace of [0.3, 0.5])
for (const night of ['off', 'strong']) {
  const res = run((i, h, rem) => {
    const z = Z[i];
    if (h < 8) return (night === 'strong' && z != null && z <= zS) ? cS : 0;
    if (h >= 22) return 0;
    const left = 22 - h;
    if (left <= 3) return rem / left;
    if (z != null && z <= zS) return cS;
    if (z != null && z <= zD) return cD;
    if (defer != null && z != null && z >= defer) return 0;
    return rem / left * pace;
  });
  add(`rev z${zD}/${zS} c${cD}/${cS} def${defer ?? '—'} p${pace} n:${night}`, 'REV', res);
}

// 2) CRASH-DIP (patrón manual): caída de D¢ en H horas que ESTABILIZA → compra fuerte
for (const D of [0.08, 0.12, 0.18]) for (const H of [3, 6])
for (const c of [20, 30, 50]) for (const pace of [0.4, 0.7]) {
  const res = run((i, h, rem, st) => {
    const drop = maxPrev(i, H) - seq[i].p;
    const stab = i > 0 && seq[i].p >= seq[i - 1].p;
    const crash = drop >= D && stab && (st.last == null || i - st.last >= 3);
    if (crash) st.last = i;
    if (h < 8) return crash ? c : 0;
    if (h >= 22) return 0;
    const left = 22 - h;
    if (left <= 3) return rem / left;
    if (crash) return c;
    return rem / left * pace;
  });
  add(`crash D${(D * 100).toFixed(0)}¢/H${H} c${c} p${pace}`, 'CRASH', res);
}

// 3) MOMENTUM: compra fuerza
for (const zU of [0.75, 1, 1.5]) for (const c of [10, 20]) for (const dd of [null, -1]) {
  const res = run((i, h, rem) => {
    const z = Z[i];
    if (h < 8 || h >= 22) return 0;
    const left = 22 - h;
    if (left <= 3) return rem / left;
    if (z != null && z >= zU + 1) return c * 2;
    if (z != null && z >= zU) return c;
    if (dd != null && z != null && z <= dd) return 0;
    return rem / left * 0.4;
  });
  add(`mom z${zU} c${c} defdn${dd ?? '—'}`, 'MOM', res);
}

// referencia TWAP 24h y TWAP 8-22 (operadores = 0 por definición aprox)
add('TWAP 24h', 'REF', run((i, h, rem) => rem / Math.max(1, 24 - h)));

// ── ranking por familia y walk-forward ──
results.sort((a, b) => b.train - a.train);
console.log('días:', FULL.length, '| train:', Object.keys(results[0].res).filter(d => d < '2026-01-01').length, '| validación 2026:', Object.keys(results[0].res).filter(d => d >= '2026-01-01').length);
console.log('\n=== TOP-12 POR TRAIN (24-25) → ¿sobrevive la VALIDACIÓN 2026? ===');
console.log('  train¢   val¢    all¢   %d+  peor   política');
for (const r of results.slice(0, 12))
  console.log('  ' + r.train.toFixed(3).padStart(6) + ' ' + r.val.toFixed(3).padStart(7) + ' ' + r.all.toFixed(3).padStart(7) + ' ' + Math.round(r.win).toString().padStart(4) + '% ' + r.worst.toFixed(1).padStart(6) + '  [' + r.fam + '] ' + r.name);
console.log('\n=== MEJOR de cada familia (por train) y su validación ===');
for (const fam of ['REV', 'CRASH', 'MOM', 'REF']) {
  const r = results.find(x => x.fam === fam);
  if (r) console.log('  [' + fam + '] train ' + r.train.toFixed(3) + ' → val ' + r.val.toFixed(3) + '  (' + r.name + ')');
}

// 4) MEZCLAS y 5) META-SWITCHER sobre los mejores por familia (elegidos por TRAIN)
const bestRev = results.find(x => x.fam === 'REV'), bestCrash = results.find(x => x.fam === 'CRASH'), bestMom = results.find(x => x.fam === 'MOM'), twap = results.find(x => x.name === 'TWAP 24h');
const opsZero = Object.fromEntries(FULL.filter(d => opsAvg[d]).map(d => [d, 0]));
const engines = { rev: bestRev.res, crash: bestCrash.res, mom: bestMom.res, ops: opsZero };
console.log('\n=== MEZCLAS FIJAS (ponderando ¢ diarios de los mejores) ===');
const mixes = [];
for (let a = 0; a <= 4; a++) for (let b = 0; a + b <= 4; b++) for (let c = 0; a + b + c <= 4; c++) {
  const d = 4 - a - b - c;
  const res = {};
  for (const day of Object.keys(bestRev.res)) {
    if (engines.crash[day] == null || engines.mom[day] == null) continue;
    res[day] = (a * engines.rev[day] + b * engines.crash[day] + c * engines.mom[day] + d * 0) / 4;
  }
  mixes.push({ name: `rev${a}/crash${b}/mom${c}/ops${d} (×25%)`, ...stats(res) });
}
mixes.sort((x, y) => y.train - x.train);
for (const m of mixes.slice(0, 6)) console.log('  train ' + m.train.toFixed(3) + ' → val ' + m.val.toFixed(3) + '  %d+ ' + Math.round(m.win) + '  peor ' + m.worst.toFixed(1) + '  ' + m.name);

console.log('\n=== META-SWITCHER (elige motor con info del DÍA PREVIO) ===');
const prevDay = {}; for (let i = 1; i < FULL.length; i++) prevDay[FULL[i]] = FULL[i - 1];
for (const T of [5, 10, 15]) {
  for (const [tag, pick] of [
    ['tend↑→mom, tend↓→rev, plano→ops', (chg) => chg > T ? 'mom' : chg < -T ? 'rev' : 'ops'],
    ['tend↑→mom, resto→rev', (chg) => chg > T ? 'mom' : 'rev'],
    ['tend↓→crash, tend↑→mom, plano→rev', (chg) => chg < -T ? 'crash' : chg > T ? 'mom' : 'rev'],
  ]) {
    const res = {};
    for (const d of Object.keys(bestRev.res)) {
      const pd = prevDay[d]; if (!pd || dayChg[pd] == null) continue;
      const eng = pick(dayChg[pd]);
      const v = engines[eng]?.[d]; if (v != null) res[d] = v;
    }
    const s = stats(res);
    console.log('  T=' + String(T).padStart(2) + '¢ ' + tag.padEnd(38) + ' train ' + s.train.toFixed(3) + ' → val ' + s.val.toFixed(3) + '  %d+ ' + Math.round(s.win) + '  peor ' + s.worst.toFixed(1));
  }
}
const usdtDay = 25_000_000 / 17.5;
console.log('\n(1¢/día ≈ ' + Math.round(0.01 * usdtDay * 250).toLocaleString('es-MX') + ' MXN/año a $25M/día)');
