// Backtest de VENTANAS HORARIAS sobre 2 AÑOS de USD/MXN horario (Yahoo).
// La decisión de producción se reduce a la ventana de compra (madrugada vs mañana vs
// parejo); esto es determinista y testeable a 2 años. Como la métrica es DIFERENCIA
// vs el TWAP del mismo día, la prima USDT (constante) se cancela.
// Incluye: costo por hora del día, ventanas, robustez trimestral, split por régimen,
// y un proxy de "Pro IA" (mañana + sizing por momentum z-score determinista).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'usdmxn-1h-2y.json');
const TZ = 'America/Mexico_City';

async function fetchData() {
  if (existsSync(CACHE)) { const c = JSON.parse(readFileSync(CACHE, 'utf8')); console.log('Cache:', c.length, 'barras'); return c; }
  const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/MXN=X?interval=1h&range=2y',
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(40_000) });
  const r = (await res.json()).chart.result[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = r.indicators.quote[0].close[i];
    if (c != null) bars.push({ ts: r.timestamp[i] * 1000, p: c });
  }
  writeFileSync(CACHE, JSON.stringify(bars));
  console.log('Descargadas', bars.length, 'barras');
  return bars;
}

const dParts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')) % 24 };
};

const bars = await fetchData();
// agrupar por día CDMX
const days = {};
for (const b of bars) { const { date, h } = dParts(b.ts); (days[date] ??= []).push({ h, p: b.p }); }
const full = Object.entries(days).filter(([, a]) => a.length >= 20).sort((a, b) => a[0] < b[0] ? -1 : 1);
console.log('Días completos (forex, >=20h):', full.length, '·', full[0][0], '→', full.at(-1)[0]);
const dayAvg = {}; for (const [d, a] of full) dayAvg[d] = a.reduce((x, y) => x + y.p, 0) / a.length;
const dayChg = {}; for (const [d, a] of full) dayChg[d] = (a.at(-1).p - a[0].p) * 100;

// ── 1) costo por hora del día (2 años) ──
console.log('\n=== POR HORA (2 años · ¢ vs TWAP del día · %días gana) ===');
for (let h = 0; h < 24; h++) {
  const ds = [];
  for (const [d, a] of full) { const xs = a.filter(r => r.h === h); if (xs.length) ds.push((dayAvg[d] - xs.reduce((x, y) => x + y.p, 0) / xs.length) * 100); }
  if (ds.length < 100) continue;
  const m = ds.reduce((x, y) => x + y, 0) / ds.length, win = ds.filter(x => x > 0).length / ds.length * 100;
  console.log('  ' + String(h).padStart(2) + 'h  ' + (m >= 0 ? '+' : '') + m.toFixed(2).padStart(6) + '¢  gana ' + String(Math.round(win)).padStart(3) + '%  n=' + ds.length);
}

// ── 2) ventanas + régimen ──
const W = [['00-07 madrugada', 0, 7], ['00-04', 0, 4], ['07-12 mañana', 7, 12], ['08-11 núcleo', 8, 11], ['07-21 laboral', 7, 21], ['12-18 tarde', 12, 18], ['18-24 noche', 18, 24]];
const winDaily = {};
console.log('\n=== VENTANAS (2 años) ===');
console.log('  ventana           media¢   %días+   peor    días↑media   días↓media');
for (const [name, a0, b0] of W) {
  const ds = [];
  for (const [d, a] of full) {
    const xs = a.filter(r => r.h >= a0 && r.h < b0);
    if (xs.length < 2) continue;
    ds.push({ d, c: (dayAvg[d] - xs.reduce((x, y) => x + y.p, 0) / xs.length) * 100 });
  }
  winDaily[name] = ds;
  const cs = ds.map(x => x.c), m = cs.reduce((x, y) => x + y, 0) / cs.length;
  const up = ds.filter(x => dayChg[x.d] > 1).map(x => x.c), dn = ds.filter(x => dayChg[x.d] < -1).map(x => x.c);
  const mu = up.reduce((x, y) => x + y, 0) / up.length, md = dn.reduce((x, y) => x + y, 0) / dn.length;
  console.log('  ' + name.padEnd(17) + (m >= 0 ? '+' : '') + m.toFixed(3).padStart(7) + '  ' + String(Math.round(cs.filter(c => c > 0).length / cs.length * 100)).padStart(4) + '%  ' + Math.min(...cs).toFixed(1).padStart(6) + '   ' + (mu >= 0 ? '+' : '') + mu.toFixed(2).padStart(6) + '      ' + (md >= 0 ? '+' : '') + md.toFixed(2).padStart(6));
}

// ── 3) robustez trimestral: madrugada vs mañana ──
console.log('\n=== ROBUSTEZ TRIMESTRAL (media ¢/día) ===');
const qOf = d => d.slice(0, 4) + 'Q' + Math.ceil(Number(d.slice(5, 7)) / 3);
const qs = [...new Set(full.map(([d]) => qOf(d)))].sort();
console.log('  trimestre   00-07 madrug   07-12 mañana   08-11 núcleo');
for (const Q of qs) {
  const line = [Q.padEnd(10)];
  for (const name of ['00-07 madrugada', '07-12 mañana', '08-11 núcleo']) {
    const ds = winDaily[name].filter(x => qOf(x.d) === Q).map(x => x.c);
    const m = ds.reduce((x, y) => x + y, 0) / ds.length;
    line.push(((m >= 0 ? '+' : '') + m.toFixed(2)).padStart(12));
  }
  console.log('  ' + line.join('  '));
}

// ── 4) proxy Pro IA: mañana + sizing momentum (z>=1 sobre las últimas 24h → compra extra) ──
console.log('\n=== PROXIES de estrategia (2 años, ¢/día vs TWAP) ===');
const seq = []; for (const [d, a] of full) for (const r of [...a].sort((x, y) => x.h - y.h)) seq.push({ d, h: r.h, p: r.p });
const zAt = i => { const h = seq.slice(Math.max(0, i - 24), i).map(x => x.p); if (h.length < 12) return null; const m = h.reduce((x, y) => x + y, 0) / h.length; const sd = Math.sqrt(h.reduce((x, y) => x + (y - m) ** 2, 0) / (h.length - 1)); return sd ? (seq[i].p - m) / sd : 0; };
function simProxy(window, momSizing) {
  const res = {}; let cur = null, remaining = 0, mxn = 0, usdt = 0, lastIdx = -99;
  const flush = () => { if (cur && usdt > 0) res[cur] = (dayAvg[cur] - mxn / usdt) * 100; };
  for (let i = 0; i < seq.length; i++) {
    const { d, h, p } = seq[i];
    if (d !== cur) { flush(); cur = d; remaining = 100; mxn = 0; usdt = 0; }
    const inWin = h >= window[0] && h < window[1];
    if (!inWin) { if (h >= window[1] && remaining > 0.01) { mxn += remaining; usdt += remaining / p; remaining = 0; } continue; }
    if (momSizing && remaining > 0.01 && i - lastIdx >= 1) { const z = zAt(i); if (z != null && z >= 1) { const amt = Math.min(z >= 2 ? 15 : 6, remaining); mxn += amt; usdt += amt / p; remaining -= amt; lastIdx = i; } }
    const slotsLeft = Math.max(1, window[1] - h);
    const amt = slotsLeft <= 1 ? remaining : Math.min(remaining, remaining / slotsLeft * (slotsLeft <= 2 ? 1 : 0.4));
    if (amt > 0.01) { mxn += amt; usdt += amt / p; remaining -= amt; }
  }
  flush(); return res;
}
const proxies = {
  'Pro-proxy (mañana+mom)': simProxy([7, 12], true),
  'Mañana pura 07-12': simProxy([7, 12], false),
  'Madrugada pura 00-07': simProxy([0, 7], false),
};
for (const [name, r] of Object.entries(proxies)) {
  const cs = Object.values(r); const m = cs.reduce((x, y) => x + y, 0) / cs.length;
  const dn = Object.entries(r).filter(([d]) => dayChg[d] < -1).map(([, c]) => c);
  console.log('  ' + name.padEnd(24) + (m >= 0 ? '+' : '') + m.toFixed(3) + '¢/día · gana ' + Math.round(cs.filter(c => c > 0).length / cs.length * 100) + '% · peor ' + Math.min(...cs).toFixed(1) + ' · en días↓ ' + (dn.reduce((x, y) => x + y, 0) / dn.length).toFixed(2) + '¢');
}
// utilidad anualizada aprox del mejor (a $25M/día, ~250 días forex/año)
const best = Object.values(proxies['Pro-proxy (mañana+mom)']);
const bm = best.reduce((x, y) => x + y, 0) / best.length;
console.log('\n  → Pro-proxy a $25M/día ≈ ' + Math.round(bm / 100 * (25_000_000 / 17.5) * 250).toLocaleString('es-MX') + ' MXN/año (~250 días forex)');
