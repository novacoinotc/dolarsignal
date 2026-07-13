// Librería del crítico: replica EXACTA del harness de switcher-refine.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PX = JSON.parse(readFileSync(path.join(HERE, 'usdmxn-1h-2y.json'), 'utf8'));
const TZ = 'America/Mexico_City';
const dParts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')) % 24 };
};
export const seq = PX.map(b => ({ ...dParts(b.ts), p: b.p, ts: b.ts }));
export const N = seq.length;
export const byDay = {}; for (let i = 0; i < N; i++) (byDay[seq[i].date] ??= []).push(i);
export const FULL = Object.entries(byDay).filter(([, a]) => a.length >= 20).map(([d]) => d).sort();
export const fullSet = new Set(FULL);
export const opsAvg = {}, dayChg = {};
for (const d of FULL) {
  const a = byDay[d].map(i => seq[i]);
  const xs = a.filter(r => r.h >= 8 && r.h < 22).map(r => r.p);
  if (xs.length >= 8) opsAvg[d] = xs.reduce((x, y) => x + y, 0) / xs.length;
  dayChg[d] = (a.at(-1).p - a[0].p) * 100;
}
// z-score 24h (idéntico)
export const Z = new Array(N).fill(null);
{
  const w = []; let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    if (w.length >= 12) { const m = s1 / w.length, sd = Math.sqrt(Math.max(0, s2 / w.length - m * m)); Z[i] = sd > 1e-9 ? (seq[i].p - m) / sd : 0; }
    w.push(seq[i].p); s1 += seq[i].p; s2 += seq[i].p ** 2;
    if (w.length > 24) { const o = w.shift(); s1 -= o; s2 -= o * o; }
  }
}
// run con costo opcional por cent de spread (cost¢ se resta al ¢/día porque encarece la compra)
export function run(decide, cost = 0) {
  const res = {}, meta = {};
  let cur = null, rem = 0, mxn = 0, usdt = 0, forced = 0, forcedPx = 0, state = {};
  const close = () => { if (cur && usdt > 0) { res[cur] = (opsAvg[cur] - mxn / usdt) * 100 - cost; meta[cur] = { forcedFrac: forced, forcedPx, avgPx: mxn / usdt }; } };
  for (let i = 0; i < N; i++) {
    const { date, h, p } = seq[i];
    if (!fullSet.has(date) || !opsAvg[date]) continue;
    if (date !== cur) { close(); cur = date; rem = 100; mxn = 0; usdt = 0; forced = 0; forcedPx = 0; state = {}; }
    let amt = decide(i, h, rem, state);
    let isForced = false;
    if (h >= 21 && rem > 0.01) { amt = rem; isForced = true; }
    if (amt > 0.01) { const a = Math.min(amt, rem); mxn += a; usdt += a / p; rem -= a; if (isForced) { forced += a; forcedPx = p; } }
  }
  close();
  return { res, meta };
}
export const stats = res => {
  const tr = [], va = [];
  for (const [d, c] of Object.entries(res)) (d < '2026-01-01' ? tr : va).push(c);
  const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const all = [...tr, ...va];
  const sd = a => { const m = avg(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  return { train: avg(tr), val: avg(va), all: avg(all), worst: Math.min(...all), sd: sd(all), nTr: tr.length, nVa: va.length };
};
export const prevDays = {}; for (let i = 0; i < FULL.length; i++) prevDays[FULL[i]] = FULL.slice(Math.max(0, i - 5), i);
export const trendK = (d, k) => { const pd = prevDays[d]; if (pd.length < k) return null; return pd.slice(-k).reduce((s, x) => s + (dayChg[x] ?? 0), 0); };

// Motor REV parametrizable (default = el del ganador)
export function makeREV({ zS = -2, zD = -1, cS = 30, cD = 10, defer = 1.5, pace = 0.5, night = 'strong' } = {}) {
  return run((i, h, rem) => {
    const z = Z[i];
    if (h < 8) return (night === 'strong' && z != null && z <= zS) ? cS : 0;
    if (h >= 22) return 0;
    const left = 22 - h; if (left <= 3) return rem / left;
    if (z != null && z <= zS) return cS;
    if (z != null && z <= zD) return cD;
    if (defer != null && z != null && z >= defer) return 0;
    return rem / left * pace;
  }).res;
}
export function makeMOM() {
  return run((i, h, rem) => {
    const z = Z[i];
    if (h < 8 || h >= 22) return 0;
    const left = 22 - h; if (left <= 3) return rem / left;
    if (z != null && z >= 2) return 40;
    if (z != null && z >= 1) return 20;
    return rem / left * 0.4;
  }).res;
}
// REV a media intensidad REAL (chunks/2 y pace intermedio) — política ejecutable
export function makeREVreal(scale = 0.5) {
  return run((i, h, rem) => {
    const z = Z[i];
    if (h < 8) return (z != null && z <= -2) ? 30 * scale : 0;
    if (h >= 22) return 0;
    const left = 22 - h; if (left <= 3) return rem / left;
    if (z != null && z <= -2) return 30 * scale;
    if (z != null && z <= -1) return 10 * scale;
    if (z != null && z >= 1.5) return 0;
    // pace intermedio entre 0.5 (rev) y 1.0 (parejo)
    return rem / left * (0.5 + (1 - 0.5) * (1 - scale));
  }).res;
}
