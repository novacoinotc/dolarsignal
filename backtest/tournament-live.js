// TORNEO FINAL sobre el periodo VIVO (RFQ real, minuto a minuto, findes incluidos):
// singles vs PORTAFOLIOS (todas las mezclas de pesos) vs SWITCHERS (regla del día previo),
// CON y SIN tesorero. Robustez = positivo en AMBAS sub-ventanas (rally jun / latigazo jul).
// Todo determinista y local. La mejor pasa a producción.
import { pool } from '../src/db.js';
import { CONFIG } from '../src/config.js';

const q = (s, p = []) => pool.query(s, p).then(r => r.rows);
const TZ = CONFIG.TIMEZONE;
const SPLIT = '2026-07-02';           // corte de sub-ventanas (entrada en vivo del Híbrido / latigazo)

// ── series diarias: ¢ vs TWAP del día, por estrategia ──
const rows = await q(`
  WITH d AS (
    SELECT date, strategy, SUM(mxn) mxn, SUM(usdt) usdt, SUM(mxn)/SUM(usdt) avg
    FROM trades WHERE strategy <> 'trader' GROUP BY date, strategy
  ), tw AS (SELECT date, avg tw FROM d WHERE strategy='twap')
  SELECT d.date, d.strategy, (tw.tw - d.avg) * 100 AS cent
  FROM d JOIN tw USING (date)
  WHERE d.strategy <> 'twap'
    AND d.date < to_char(now() AT TIME ZONE '${TZ}','YYYY-MM-DD')
  ORDER BY d.date`);
const byStrat = {};
for (const r of rows) (byStrat[r.strategy] ??= {})[r.date] = Number(r.cent);

// cambio diario del precio (para las reglas de régimen del switcher)
const chgRows = await q(`
  SELECT to_char(to_timestamp(ts/1000.0) AT TIME ZONE '${TZ}','YYYY-MM-DD') d,
         ((array_agg(price ORDER BY ts DESC))[1] - (array_agg(price ORDER BY ts ASC))[1]) * 100 chg
  FROM ticks WHERE source='bitso' GROUP BY 1 ORDER BY 1`);
const dayChg = Object.fromEntries(chgRows.map(r => [r.d, Number(r.chg)]));

// días donde TODAS las candidatas tienen dato (para comparar parejo)
const CANDS = ['bot','aggressive','sessions','aggressive_ai','bot_ai','momentum','momentum_opus','hybrid','tesorero'];
const DATES = Object.keys(byStrat.tesorero || {}).filter(d => CANDS.every(s => byStrat[s]?.[d] != null)).sort();
const prevOf = {}; for (let i = 1; i < DATES.length; i++) prevOf[DATES[i]] = DATES[i - 1];

const stats = fn => {
  const A = [], B = [], all = [];
  for (const d of DATES) { const c = fn(d); if (c == null) continue; all.push(c); (d < SPLIT ? A : B).push(c); }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  return { a: avg(A), b: avg(B), all: avg(all), worst: Math.min(...all), win: 100 * all.filter(c => c > 0).length / all.length, n: all.length };
};
const out = [];
const add = (name, kind, fn) => { const s = stats(fn); if (s.all != null) out.push({ name, kind, ...s }); };

// 1) SINGLES
for (const s of CANDS) add(s, 'single', d => byStrat[s][d]);

// 2) PORTAFOLIOS: todas las mezclas en pasos de 25% sobre las candidatas (+peso a TWAP=0)
const KEYS = [...CANDS, 'TWAP'];
function* comps(units, k) {
  if (k === 1) { yield [units]; return; }
  for (let u = 0; u <= units; u++) for (const rest of comps(units - u, k - 1)) yield [u, ...rest];
}
for (const w of comps(4, KEYS.length)) {
  const active = w.map((u, i) => [KEYS[i], u]).filter(([, u]) => u > 0);
  if (active.length < 2) continue;                       // singles ya cubiertos
  const name = active.map(([k, u]) => `${u * 25}%${k}`).join(' + ');
  add(name, 'mix', d => active.reduce((s, [k, u]) => s + (k === 'TWAP' ? 0 : byStrat[k][d]) * u, 0) / 4);
}

// 3) SWITCHERS: régimen por el cambio del DÍA PREVIO (up→X, down→Y, plano→Z)
const SW = ['aggressive_ai','momentum','momentum_opus','aggressive','hybrid','tesorero','bot','TWAP'];
const val = (k, d) => k === 'TWAP' ? 0 : byStrat[k][d];
for (const T of [3, 5, 8]) for (const X of SW) for (const Y of SW) for (const Z of SW) {
  if (X === Y && Y === Z) continue;
  add(`↑${X} ↓${Y} =${Z} (T${T})`, 'switch', d => {
    const pd = prevOf[d]; if (!pd || dayChg[pd] == null) return null;
    const t = dayChg[pd];
    return val(t > T ? X : t < -T ? Y : Z, d);
  });
}

// 4) perseguir al campeón de ayer (la trampa conocida) como referencia
add('campeón-de-ayer', 'ref', d => {
  const pd = prevOf[d]; if (!pd) return null;
  let best = null, bc = -Infinity;
  for (const s of CANDS) if (byStrat[s][pd] > bc) { bc = byStrat[s][pd]; best = s; }
  return byStrat[best][d];
});

// ── ranking: ROBUSTAS primero (positivas en AMBAS ventanas), por promedio total ──
const robust = out.filter(o => o.a > 0 && o.b > 0).sort((x, y) => y.all - x.all);
const fmt = o => `  ${o.all.toFixed(3).padStart(7)}  ${o.a.toFixed(2).padStart(6)} ${o.b.toFixed(2).padStart(6)}  ${Math.round(o.win).toString().padStart(3)}%  ${o.worst.toFixed(1).padStart(6)}  [${o.kind}] ${o.name}`;
console.log(`días: ${DATES.length} (ventana A <${SPLIT}: rally · B: latigazo)  candidatas: ${CANDS.length}  combos evaluados: ${out.length}`);
console.log('\n=== ROBUSTAS (positivas en A y B), top 20 por ¢/día total ===');
console.log('   all¢     ventA  ventB   %d+   peor   qué es');
for (const o of robust.slice(0, 20)) console.log(fmt(o));
console.log('\n=== top 8 por promedio total (aunque NO sean robustas) ===');
for (const o of [...out].sort((x, y) => y.all - x.all).slice(0, 8)) console.log(fmt(o));
console.log('\n=== referencias ===');
for (const o of out.filter(x => x.kind === 'ref' || x.kind === 'single')) console.log(fmt(o));
await pool.end();
