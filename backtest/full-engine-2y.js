// Backtest 2 AÑOS del MOTOR COMPLETO de señales (como el sistema vivo, a escala horaria):
// z-score + RSI + Bollinger + correlación BTC + blackout de eventos Fed/Banxico,
// dirigiendo la política de REVERSIÓN (la ganadora). Variantes aisladas para medir
// cuánto SUMA cada capa de información vs la reversión simple de solo-precio.
// (Noticias y veredictos de Opus NO son replicables históricamente — sin archivo.)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zscore, rsi, bollinger } from '../src/indicators.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TZ = 'America/Mexico_City';
const PX = JSON.parse(readFileSync(path.join(HERE, 'usdmxn-1h-2y.json'), 'utf8'));

// ── BTC 2 años (Coinbase, bloques de 300 velas) ──
const BTC_CACHE = path.join(HERE, 'btc-1h-2y.json');
async function fetchBtc2y(fromMs, toMs) {
  if (existsSync(BTC_CACHE)) { const c = JSON.parse(readFileSync(BTC_CACHE, 'utf8')); console.log('BTC cache:', c.length); return c; }
  console.log('Descargando 2 años de BTC/USD horario…');
  const out = new Map(); const STEP = 300 * 3600_000;
  for (let s = fromMs; s < toMs; s += STEP) {
    const e = Math.min(s + STEP, toMs);
    try {
      const r = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) for (const row of await r.json()) out.set(row[0] * 1000, row[4]);
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  const bars = [...out.entries()].map(([ts, p]) => ({ ts, p })).sort((a, b) => a.ts - b.ts);
  writeFileSync(BTC_CACHE, JSON.stringify(bars));
  console.log('BTC:', bars.length, 'barras'); return bars;
}

// ── Eventos de alto impacto (fechas de DECISIÓN, aproximadas para 2024-25; 2026 del calendario) ──
const EVENTS = [
  // FOMC 2024-2026
  '2024-07-31','2024-09-18','2024-11-07','2024-12-18',
  '2025-01-29','2025-03-19','2025-05-07','2025-06-18','2025-07-30','2025-09-17','2025-10-29','2025-12-10',
  '2026-01-28','2026-03-18','2026-04-29','2026-06-17',
  // Banxico 2024-2026 (aprox: jueves de decisión)
  '2024-08-08','2024-09-26','2024-11-14','2024-12-19',
  '2025-02-06','2025-03-27','2025-05-15','2025-06-26','2025-08-07','2025-09-25','2025-11-06','2025-12-18',
  '2026-02-05','2026-03-26','2026-05-14','2026-06-25',
];
const EVENT_SET = new Set(EVENTS);

const dParts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')) % 24 };
};

const btc = await fetchBtc2y(PX[0].ts, PX.at(-1).ts);
const btcByHour = new Map(btc.map(b => [Math.floor(b.ts / 3600_000), b.p]));

// secuencia con señales del motor completo
const seq = PX.map(b => ({ ts: b.ts, ...dParts(b.ts), p: b.p }));
const closes = seq.map(x => x.p);
const btcSeries = seq.map(x => btcByHour.get(Math.floor(x.ts / 3600_000)) ?? null);

function signalsAt(i) {
  if (i < 26) return null;
  const win = closes.slice(i - 25, i + 1);
  const price = closes[i];
  const z = zscore(closes.slice(i - 24, i), price);
  const r = rsi(win, 14);
  const bb = bollinger(win, 20, 2);
  let btcZ = null;
  const bwin = btcSeries.slice(i - 24, i + 1).filter(x => x != null);
  if (bwin.length > 15) btcZ = zscore(bwin.slice(0, -1), bwin.at(-1));
  // score como el motor vivo (sin prima RFQ ni caída-5min, no disponibles a esta escala)
  let score = 0;
  if (z <= -1.5) score += 2; else if (z <= -1) score += 1;
  if (r != null) { if (r < 20) score += 2; else if (r < 30) score += 1; }
  if (bb && price <= bb.lower) score += 1;
  const tierBase = score >= 4 ? 'STRONG' : score >= 2.5 ? 'BUY' : null;
  const scoreBtc = score + ((btcZ != null && btcZ >= 1.5) ? 1 : 0);
  const tierBtc = scoreBtc >= 4 ? 'STRONG' : scoreBtc >= 2.5 ? 'BUY' : null;
  return { z, tierBase, tierBtc };
}

const byDay = {}; for (const s of seq) (byDay[s.date] ??= []).push(s);
const full = new Set(Object.entries(byDay).filter(([, a]) => a.length >= 20).map(([d]) => d));
const dayAvg = {}; for (const d of full) { const a = byDay[d]; dayAvg[d] = a.reduce((x, y) => x + y.p, 0) / a.length; }
const dayChg = {}; for (const d of full) { const a = byDay[d]; dayChg[d] = (a.at(-1).p - a[0].p) * 100; }

// política de reversión con distintos gatillos
function sim({ trigger, blackout = false }) {
  const res = {}; let cur = null, remaining = 0, mxn = 0, usdt = 0, idx = 0, hrs = 0;
  for (let i = 0; i < seq.length; i++) {
    const { date, p } = seq[i];
    if (!full.has(date)) continue;
    if (date !== cur) { if (cur && usdt > 0) res[cur] = (dayAvg[cur] - mxn / usdt) * 100; cur = date; remaining = 100; mxn = 0; usdt = 0; idx = 0; hrs = byDay[date].length; }
    idx++;
    const left = hrs - idx + 1;
    const sig = signalsAt(i);
    let amt = 0;
    const isEventDay = EVENT_SET.has(date);
    if (left <= 1) amt = remaining;
    else if (left <= 3) amt = remaining / left;
    else if (sig) {
      const tier = trigger === 'z' ? (sig.z <= -2 ? 'STRONG' : sig.z <= -1 ? 'BUY' : null)
                 : trigger === 'engine' ? sig.tierBase
                 : sig.tierBtc;                                   // 'engine+btc'
      const blocked = blackout && isEventDay;
      if (tier && !blocked) amt = Math.min(remaining, tier === 'STRONG' ? 20 : 10);
      else if (sig.z >= 1) amt = 0;                               // difiere cuando sube
      else amt = Math.min(remaining, remaining / left * 0.4);
    } else amt = Math.min(remaining, remaining / left * 0.4);
    if (amt > 0.01) { mxn += amt; usdt += amt / p; remaining -= amt; }
  }
  if (cur && usdt > 0) res[cur] = (dayAvg[cur] - mxn / usdt) * 100;
  return res;
}

const variants = {
  'Reversión z (solo precio)':      sim({ trigger: 'z' }),
  'Motor completo (z+RSI+BB)':      sim({ trigger: 'engine' }),
  'Motor + BTC':                    sim({ trigger: 'engine+btc' }),
  'Motor + BTC + blackout eventos': sim({ trigger: 'engine+btc', blackout: true }),
};

console.log('\n=== MOTOR COMPLETO vs SOLO PRECIO (2 años, ' + full.size + ' días, ¢/día vs TWAP) ===');
const qOf = d => d.slice(0, 4) + 'Q' + Math.ceil(Number(d.slice(5, 7)) / 3);
const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
for (const [name, res] of Object.entries(variants)) {
  const cs = Object.values(res);
  const up = Object.entries(res).filter(([d]) => dayChg[d] > 1).map(([, c]) => c);
  const dn = Object.entries(res).filter(([d]) => dayChg[d] < -1).map(([, c]) => c);
  console.log('  ' + name.padEnd(32) + (avg(cs) >= 0 ? '+' : '') + avg(cs).toFixed(3) + '¢ · gana ' + Math.round(cs.filter(c => c > 0).length / cs.length * 100) + '% · peor ' + Math.min(...cs).toFixed(1) + ' · ↑' + avg(up).toFixed(2) + ' ↓' + (avg(dn) >= 0 ? '+' : '') + avg(dn).toFixed(2));
}
console.log('\n=== ROBUSTEZ TRIMESTRAL ===');
const names = Object.keys(variants);
console.log('  trim      ' + names.map(n => n.slice(0, 12).padStart(14)).join(''));
const qs = [...new Set([...full].map(qOf))].sort();
for (const Q of qs) {
  const line = [Q.padEnd(8)];
  for (const n of names) {
    const cs = Object.entries(variants[n]).filter(([d]) => qOf(d) === Q).map(([, c]) => c);
    line.push(((avg(cs) >= 0 ? '+' : '') + avg(cs).toFixed(2)).padStart(14));
  }
  console.log('  ' + line.join(''));
}
// días de evento: ¿el blackout ayudó?
const evDays = [...full].filter(d => EVENT_SET.has(d));
console.log('\n=== SOLO DÍAS DE EVENTO (n=' + evDays.length + ') ===');
for (const n of ['Motor + BTC', 'Motor + BTC + blackout eventos']) {
  const cs = evDays.map(d => variants[n][d]).filter(x => x != null);
  console.log('  ' + n.padEnd(32) + (avg(cs) >= 0 ? '+' : '') + avg(cs).toFixed(3) + '¢/día en eventos');
}
const usdtDay = 25_000_000 / 17.5;
for (const n of names) {
  const m = avg(Object.values(variants[n]));
  console.log('  → ' + n + ' ≈ ' + (m >= 0 ? '+' : '') + Math.round(m / 100 * usdtDay * 250).toLocaleString('es-MX') + ' MXN/año');
}
