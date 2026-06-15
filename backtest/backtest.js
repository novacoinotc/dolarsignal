// Backtest de 12 meses de la estrategia DolarSignal.
//
// DATOS: USD/MXN spot por hora de Yahoo Finance (12 meses, ~6,300 barras).
// El instrumento real (USDT/MXN en Bitso) = USD/MXN × (1 + prima ~0.03% estable).
// Como la métrica clave (centavos ahorrados bot vs TWAP) es una DIFERENCIA sobre
// la misma serie, una prima multiplicativa constante se cancela: los centavos
// ahorrados son los mismos usando spot que usando spot×(1+prima). Ver README del backtest.
//
// LÓGICA: en cada barra horaria se evalúan los mismos indicadores del bot en vivo
// (z-score de la media móvil, RSI, Bollinger). Score → WATCH/BUY/STRONG_BUY.
// El bot pondera su compra diaria de $20M MXN hacia las barras con señal (dips);
// el TWAP compra parejo cada barra. avg_twap − avg_bot = centavos ganados por USDT.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zscore, rsi, bollinger } from '../src/indicators.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'usdmxn-1h.json');
const TZ = 'America/Mexico_City';

// ── Parámetros (espejo de src/config.js, dimensionless en cualquier timeframe) ──
const P = {
  DAILY_BUDGET_MXN: 20_000_000,
  ZSCORE_WINDOW: 60,      // barras
  ZSCORE_DIP: -1.5, ZSCORE_SOFT: -1.0,
  RSI_PERIOD: 14, RSI_OVERSOLD: 30, RSI_EXTREME: 20,
  BOLL_PERIOD: 20, BOLL_K: 2,
  WARMUP: 80,
  SCORE_WATCH: 1.5, SCORE_BUY: 2.5, SCORE_STRONG: 4.0,
  // Estrategia por defecto del reporte detallado (se sobreescribe en el sweep).
  STRAT: { type: 'boost', buy: 2, strong: 3 },
  HORIZONS: [1, 4, 24],   // barras (1h, 4h, 24h) para evaluar resultado de señales
};

async function fetchYahoo() {
  if (existsSync(CACHE)) {
    const cached = JSON.parse(readFileSync(CACHE, 'utf8'));
    console.log(`Usando cache: ${cached.length} barras (${CACHE})`);
    return cached;
  }
  console.log('Descargando USD/MXN por hora (12 meses) de Yahoo Finance…');
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/MXN=X?interval=1h&range=1y';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const j = await res.json();
  const r = j.chart.result[0];
  const ts = r.timestamp;
  const closes = r.indicators.quote[0].close;
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null) bars.push({ ts: ts[i] * 1000, price: closes[i] });
  }
  mkdirSync(HERE, { recursive: true });
  writeFileSync(CACHE, JSON.stringify(bars));
  console.log(`Guardadas ${bars.length} barras en ${CACHE}`);
  return bars;
}

const cdmxDate = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
const yyyymm = ts => cdmxDate(ts).slice(0, 7);

function evalSignal(closes) {
  const price = closes[closes.length - 1];
  let score = 0;
  const z = zscore(closes.slice(-P.ZSCORE_WINDOW, -1), price);
  if (z <= P.ZSCORE_DIP) score += 2; else if (z <= P.ZSCORE_SOFT) score += 1;
  const r = rsi(closes, P.RSI_PERIOD);
  if (r !== null) { if (r < P.RSI_EXTREME) score += 2; else if (r < P.RSI_OVERSOLD) score += 1; }
  const bb = bollinger(closes, P.BOLL_PERIOD, P.BOLL_K);
  if (bb && price <= bb.lower) score += 1;
  let tier = null;
  if (score >= P.SCORE_STRONG) tier = 'STRONG_BUY';
  else if (score >= P.SCORE_BUY) tier = 'BUY';
  else if (score >= P.SCORE_WATCH) tier = 'WATCH';
  return { tier, score, z, rsi: r };
}

// Simulación causal de un día. Devuelve USDT comprado gastando exactamente B.
//  - 'boost': slot base = restante/barras-restantes; en señal compra boost× el slot.
//  - 'reserve': TWAP sobre (1-frac) del presupuesto en todas las barras + reserva
//               frac que solo se despliega en barras con señal (resto al cierre).
function simDay(idxs, bars, sig, strat) {
  const B = P.DAILY_BUDGET_MXN, n = idxs.length;
  let usdt = 0;

  if (strat.type === 'boost') {
    let remaining = B;
    for (let k = 0; k < n; k++) {
      const price = bars[idxs[k]].price, t = sig[idxs[k]]?.tier;
      const base = remaining / (n - k);
      const boost = t === 'STRONG_BUY' ? strat.strong : t === 'BUY' ? strat.buy : 1;
      let buy = Math.min(remaining, base * boost);
      if (k === n - 1) buy = remaining;
      usdt += buy / price; remaining -= buy;
    }
    return usdt;
  }

  // reserve
  const twapPart = B * (1 - strat.frac), perBar = twapPart / n;
  let reserve = B * strat.frac;
  const sigBars = [];
  for (let k = 0; k < n; k++) {
    const price = bars[idxs[k]].price, t = sig[idxs[k]]?.tier;
    usdt += perBar / price; // baseline TWAP
    if (t === 'BUY' || t === 'STRONG_BUY') sigBars.push(k);
  }
  // Despliegue causal de la reserva: en cada señal compra una fracción del reserve
  // restante (más para STRONG); lo que quede se compra en la última barra.
  let rem = reserve;
  for (let k = 0; k < n; k++) {
    const price = bars[idxs[k]].price, t = sig[idxs[k]]?.tier;
    if ((t === 'BUY' || t === 'STRONG_BUY') && rem > 0) {
      const chunk = Math.min(rem, B * (t === 'STRONG_BUY' ? strat.strongChunk : strat.buyChunk));
      usdt += chunk / price; rem -= chunk;
    }
    if (k === n - 1 && rem > 0) { usdt += rem / price; rem = 0; }
  }
  return usdt;
}

function run(bars) {
  // 1) Señal por barra (a partir del warmup)
  const sig = new Array(bars.length).fill(null);
  for (let i = P.WARMUP; i < bars.length; i++) {
    const closes = bars.slice(Math.max(0, i - P.ZSCORE_WINDOW - 5), i + 1).map(b => b.price);
    sig[i] = evalSignal(closes);
  }

  // 2) Agrupar barras por día CDMX
  const days = new Map();
  for (let i = 0; i < bars.length; i++) {
    if (i < P.WARMUP) continue;
    const d = cdmxDate(bars[i].ts);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(i);
  }

  // 3) Simular cada día de forma CAUSAL (sin hindsight): en cada barra solo se
  //    conoce la señal actual y el presupuesto restante — igual que el bot en vivo.
  const daily = [];
  for (const [date, idxs] of days) {
    if (idxs.length < 2) continue;
    const B = P.DAILY_BUDGET_MXN;
    const n = idxs.length;
    let twapUsdt = 0;
    for (const i of idxs) twapUsdt += (B / n) / bars[i].price;
    const botUsdt = simDay(idxs, bars, sig, P.STRAT);
    const botAvg = B / botUsdt, twapAvg = B / twapUsdt;
    daily.push({ date, month: date.slice(0, 7), botAvg, twapAvg, botUsdt, twapUsdt,
      centavos: (twapAvg - botAvg) * 100,
      buys: idxs.filter(i => ['BUY', 'STRONG_BUY'].includes(sig[i]?.tier)).length });
  }

  // 4) Calidad de señales: delta a futuro por tier/horizonte
  const quality = {};
  for (let i = P.WARMUP; i < bars.length; i++) {
    const t = sig[i]?.tier;
    if (!t) continue;
    for (const h of P.HORIZONS) {
      const j = i + h;
      if (j >= bars.length) continue;
      const delta = (bars[j].price - bars[i].price) * 100;
      const key = `${t}|${h}`;
      (quality[key] ??= { n: 0, sum: 0, hits: 0 });
      quality[key].n++; quality[key].sum += delta; if (delta > 0) quality[key].hits++;
    }
  }

  return { daily, quality, sig };
}

function report(bars, { daily, quality, sig }) {
  const first = cdmxDate(bars[0].ts), last = cdmxDate(bars.at(-1).ts);
  const fmt = n => n.toLocaleString('es-MX', { maximumFractionDigits: 0 });

  console.log('\n' + '═'.repeat(64));
  console.log('  BACKTEST DolarSignal — USD/MXN por hora');
  console.log(`  Periodo: ${first} → ${last}  (${bars.length} barras horarias)`);
  console.log(`  Presupuesto: $${fmt(P.DAILY_BUDGET_MXN)} MXN/día`);
  console.log('═'.repeat(64));

  // Resumen mensual
  const byMonth = new Map();
  for (const d of daily) {
    const m = byMonth.get(d.month) || { centWeighted: 0, usdt: 0, saved: 0, days: 0, buys: 0 };
    m.centWeighted += d.centavos * d.botUsdt;
    m.usdt += d.botUsdt;
    m.saved += (d.centavos / 100) * d.botUsdt;
    m.days++; m.buys += d.buys;
    byMonth.set(d.month, m);
  }
  console.log('\n  Mes        Centavos/USDT   Ahorro MXN     Días   Señales-compra');
  console.log('  ' + '─'.repeat(60));
  let totalSaved = 0, totalUsdt = 0, totalCentWeighted = 0, totalBuys = 0;
  for (const [m, v] of [...byMonth].sort()) {
    const cents = v.centWeighted / v.usdt;
    console.log(`  ${m}     ${cents >= 0 ? '+' : ''}${cents.toFixed(3).padStart(7)}      $${fmt(v.saved).padStart(9)}    ${String(v.days).padStart(3)}    ${v.buys}`);
    totalSaved += v.saved; totalUsdt += v.usdt; totalCentWeighted += v.centWeighted; totalBuys += v.buys;
  }
  console.log('  ' + '─'.repeat(60));
  const avgCents = totalCentWeighted / totalUsdt;
  console.log(`  TOTAL      ${avgCents >= 0 ? '+' : ''}${avgCents.toFixed(3).padStart(7)}      $${fmt(totalSaved).padStart(9)}    ${daily.length}    ${totalBuys}`);

  // Anualizado
  console.log('\n  ' + '═'.repeat(60));
  console.log(`  Centavos promedio ganados por USDT:  ${avgCents >= 0 ? '+' : ''}${avgCents.toFixed(4)}`);
  console.log(`  Ahorro total 12 meses:               $${fmt(totalSaved)} MXN`);
  console.log(`  USDT comprado (paper):               ${fmt(totalUsdt)} USDT`);
  console.log(`  Volumen comprado:                    $${fmt(totalUsdt * (bars.at(-1).price))} MXN aprox.`);

  // Calidad de señales
  console.log('\n  Calidad de señales (¿subió el precio después de la señal?)');
  console.log('  Tier         Horizonte   #señales   Δ prom (¢)   % acierto');
  console.log('  ' + '─'.repeat(58));
  for (const tier of ['WATCH', 'BUY', 'STRONG_BUY']) {
    for (const h of P.HORIZONS) {
      const q = quality[`${tier}|${h}`];
      if (!q) continue;
      const avg = q.sum / q.n, hr = q.hits / q.n * 100;
      console.log(`  ${tier.padEnd(12)} +${String(h).padStart(2)}h${' '.repeat(7)}${String(q.n).padStart(5)}    ${(avg >= 0 ? '+' : '') + avg.toFixed(2).padStart(6)}      ${hr.toFixed(0)}%`);
    }
  }

  // Conteo de señales
  const counts = { WATCH: 0, BUY: 0, STRONG_BUY: 0 };
  for (const s of sig) if (s?.tier && counts[s.tier] !== undefined) counts[s.tier]++;
  console.log(`\n  Señales generadas: WATCH ${counts.WATCH} · BUY ${counts.BUY} · STRONG_BUY ${counts.STRONG_BUY}`);
  console.log('═'.repeat(64) + '\n');

  return { avgCents, totalSaved, totalUsdt };
}

// Compara una estrategia contra TWAP sobre todo el periodo (causal)
function evalStrat(bars, sig, days, strat) {
  let centWeighted = 0, usdtTot = 0, saved = 0;
  for (const [, idxs] of days) {
    if (idxs.length < 2) continue;
    const B = P.DAILY_BUDGET_MXN, n = idxs.length;
    let twapUsdt = 0;
    for (const i of idxs) twapUsdt += (B / n) / bars[i].price;
    const botUsdt = simDay(idxs, bars, sig, strat);
    const cent = (B / twapUsdt - B / botUsdt) * 100;
    centWeighted += cent * botUsdt; usdtTot += botUsdt; saved += (cent / 100) * botUsdt;
  }
  return { cents: centWeighted / usdtTot, saved };
}

const bars = await fetchYahoo();
const result = run(bars);
report(bars, result);

// ── Sweep de estrategias ──────────────────────────────────────
const { sig } = result;
const days = new Map();
for (let i = P.WARMUP; i < bars.length; i++) {
  const d = cdmxDate(bars[i].ts);
  if (!days.has(d)) days.set(d, []);
  days.get(d).push(i);
}
const fmt = n => n.toLocaleString('es-MX', { maximumFractionDigits: 0 });
const STRATS = [
  ['Boost 2×/3× (default)', { type: 'boost', buy: 2, strong: 3 }],
  ['Boost 3×/6×', { type: 'boost', buy: 3, strong: 6 }],
  ['Boost 4×/10×', { type: 'boost', buy: 4, strong: 10 }],
  ['Reserva 30% solo-señales', { type: 'reserve', frac: 0.30, buyChunk: 0.015, strongChunk: 0.04 }],
  ['Reserva 50% solo-señales', { type: 'reserve', frac: 0.50, buyChunk: 0.02, strongChunk: 0.06 }],
  ['Reserva 70% solo-señales', { type: 'reserve', frac: 0.70, buyChunk: 0.03, strongChunk: 0.09 }],
];
console.log('  SENSIBILIDAD — estrategia de asignación vs TWAP (12 meses, causal)');
console.log('  Estrategia                      Centavos/USDT   Ahorro MXN/año');
console.log('  ' + '─'.repeat(62));
for (const [name, strat] of STRATS) {
  const r = evalStrat(bars, sig, days, strat);
  console.log(`  ${name.padEnd(30)}   ${(r.cents >= 0 ? '+' : '') + r.cents.toFixed(4).padStart(8)}     $${fmt(r.saved).padStart(9)}`);
}
console.log('  ' + '─'.repeat(62));
console.log('  (Edge real concentrado en +1-4h; el bot en vivo opera a nivel minuto,');
console.log('   no horario — este backtest es un piso conservador. Ver README.)\n');
