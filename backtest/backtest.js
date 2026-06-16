// Backtest de 12 meses de TODAS las estrategias de DolarSignal.
//
// DATOS:
//  - USD/MXN spot por hora (Yahoo). Proxy del USDT/MXN: USDT/MXN = USD/MXN×(1+prima).
//    Como las métricas son DIFERENCIAS entre estrategias sobre la misma serie, una
//    prima multiplicativa constante se cancela → los centavos son válidos.
//  - BTC/USD por hora (Coinbase) para la señal de correlación cripto.
//
// Simula hora por hora, de forma CAUSAL (sin ver el futuro), las 7 estrategias del
// laboratorio en vivo: pareja, cauteloso, agresivo, sesiones, viernes, inteligente
// y trader. Reporta centavos ganados vs la compra pareja (TWAP) y el P&L del trader.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zscore, rsi, bollinger } from '../src/indicators.js';
import { fetchBtcHourly } from './btc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'usdmxn-1h.json');
const TZ = 'America/Mexico_City';

const P = {
  DAILY_BUDGET_MXN: 20_000_000,
  ZSCORE_WINDOW: 60, ZSCORE_DIP: -1.5, ZSCORE_SOFT: -1.0,
  RSI_PERIOD: 14, RSI_OVERSOLD: 30, RSI_EXTREME: 20,
  BOLL_PERIOD: 20, BOLL_K: 2, BTC_WINDOW: 60, BTC_PUMP_Z: 1.5,
  WARMUP: 80, SCORE_WATCH: 1.5, SCORE_BUY: 2.5, SCORE_STRONG: 4.0,
  HORIZONS: [1, 4, 24],
  FRIDAY_CUTOFF_MIN: 14 * 60 + 30, WEEKEND_DAYS: 2,
  SLOT_MIN: 60,                 // en el backtest, 1 "slot" = 1 barra horaria
  CATCHUP_SLOTS: 3,
  // Trader: compra barato, toma ganancia al subir
  TRADER: { buyChunk: 1e6, strongChunk: 2e6, sellChunk: 1.5e6, maxPos: 8e6, takeProfit: 4, sellZ: 1.5, sellRsi: 70 },
};

// Estrategias acumuladoras (espejo de src/strategies.js)
const ACC = {
  twap:       { label: 'Pareja (TWAP)', slotPace: 1.0, buyPct: 0,    strongPct: 0,    session: false, friday: false },
  bot:        { label: 'Cauteloso',     slotPace: 1.0, buyPct: 0.02, strongPct: 0.05, session: false, friday: false },
  aggressive: { label: 'Agresivo',      slotPace: 0.4, buyPct: 0.08, strongPct: 0.20, session: false, friday: false },
  sessions:   { label: 'Sesiones',      slotPace: 0.6, buyPct: 0.05, strongPct: 0.12, session: true,  friday: false },
  friday:     { label: 'Viernes',       slotPace: 1.0, buyPct: 0.02, strongPct: 0.05, session: false, friday: true  },
  smart:      { label: 'Inteligente',   slotPace: 0.4, buyPct: 0.08, strongPct: 0.20, session: true,  friday: true  },
};
const SESSION_W = { europea: 1.3, americana: 1.4, otros: 0.5 };

async function fetchYahoo() {
  if (existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, 'utf8'));
    console.log(`USD/MXN cache: ${c.length} barras`);
    return c;
  }
  console.log('Descargando USD/MXN por hora (12 meses) de Yahoo…');
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/MXN=X?interval=1h&range=1y';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const r = (await res.json()).chart.result[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (r.indicators.quote[0].close[i] != null) bars.push({ ts: r.timestamp[i] * 1000, price: r.indicators.quote[0].close[i] });
  }
  mkdirSync(HERE, { recursive: true });
  writeFileSync(CACHE, JSON.stringify(bars));
  console.log(`USD/MXN: ${bars.length} barras`);
  return bars;
}

const parts = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.find(x => x.type === 'weekday').value);
  const min = (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value);
  return { dow, min };
};
const cdmxDate = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
const sessionOf = min => (min >= 120 && min < 480) ? 'europea' : (min >= 480 && min < 900) ? 'americana' : 'otros';

// Señal causal en la barra i (solo datos pasados)
function signalAt(prices, btcByTs, bars, i) {
  const price = prices[i];
  let score = 0;
  const z = zscore(prices.slice(Math.max(0, i - P.ZSCORE_WINDOW), i), price);
  if (z <= P.ZSCORE_DIP) score += 2; else if (z <= P.ZSCORE_SOFT) score += 1;
  const win = prices.slice(0, i + 1);
  const r = rsi(win, P.RSI_PERIOD);
  if (r !== null) { if (r < P.RSI_EXTREME) score += 2; else if (r < P.RSI_OVERSOLD) score += 1; }
  const bb = bollinger(win, P.BOLL_PERIOD, P.BOLL_K);
  if (bb && price <= bb.lower) score += 1;
  // BTC: alza fuerte → USDT barato
  const btcWin = [];
  for (let k = Math.max(0, i - P.BTC_WINDOW); k <= i; k++) { const b = btcByTs.get(bars[k].ts); if (b) btcWin.push(b); }
  if (btcWin.length > 30) {
    const bz = zscore(btcWin.slice(0, -1), btcWin[btcWin.length - 1]);
    if (bz >= P.BTC_PUMP_Z) score += 1;
  }
  let tier = null;
  if (score >= P.SCORE_STRONG) tier = 'STRONG_BUY';
  else if (score >= P.SCORE_BUY) tier = 'BUY';
  else if (score >= P.SCORE_WATCH) tier = 'WATCH';
  return { tier, score, z, rsi: r };
}

function dayBudget(cfg, dow) {
  // NOTA: el forex no opera fin de semana, así que en el backtest NO inflamos el
  // presupuesto del viernes (eso haría comprar 40% más volumen que las demás y la
  // comparación sería injusta). Aquí "Viernes" solo prueba el TIMING: concentrar la
  // compra del viernes antes del cierre 14:30. El efecto viernes real (prima de fin
  // de semana en Bitso) solo se mide EN VIVO. Ver README.
  if (cfg.friday && dow === 5) return { budget: P.DAILY_BUDGET_MXN, endMin: P.FRIDAY_CUTOFF_MIN };
  return { budget: P.DAILY_BUDGET_MXN, endMin: 1440 };
}

function run(bars, btcByTs) {
  const prices = bars.map(b => b.price);
  const sig = bars.map((_, i) => i < P.WARMUP ? null : signalAt(prices, btcByTs, bars, i));

  // Agrupar índices por día CDMX
  const days = new Map();
  for (let i = P.WARMUP; i < bars.length; i++) {
    const d = cdmxDate(bars[i].ts);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(i);
  }

  // Acumuladoras: por estrategia, totales globales y por día
  const totals = {}; const perDay = {};
  for (const k of Object.keys(ACC)) { totals[k] = { mxn: 0, usdt: 0, buys: 0 }; perDay[k] = {}; }

  for (const [date, idxs] of days) {
    for (const [k, cfg] of Object.entries(ACC)) {
      const dow = parts(bars[idxs[0]].ts).dow;
      const { budget, endMin } = dayBudget(cfg, dow);
      if (budget < 1) { perDay[k][date] = null; continue; }
      // Barras válidas del día (dentro de la ventana endMin)
      const valid = idxs.filter(i => parts(bars[i].ts).min <= endMin);
      if (!valid.length) { perDay[k][date] = null; continue; }
      let remaining = budget, usdt = 0, mxn = 0, buys = 0;
      // Compras por señal (causal): al recorrer las barras en orden
      for (let vi = 0; vi < valid.length; vi++) {
        const i = valid[vi];
        const price = prices[i], t = sig[i]?.tier, min = parts(bars[i].ts).min;
        // 1) compra oportunista por señal
        if ((t === 'BUY' || t === 'STRONG_BUY') && (cfg.buyPct > 0)) {
          const pct = t === 'STRONG_BUY' ? cfg.strongPct : cfg.buyPct;
          const amt = Math.min(remaining, budget * pct);
          if (amt > 0) { usdt += amt / price; mxn += amt; remaining -= amt; buys++; }
        }
        // 2) slot de relleno
        const slotsLeft = valid.length - vi;
        const evenPace = remaining / slotsLeft;
        const pace = slotsLeft <= P.CATCHUP_SLOTS ? 1 : cfg.slotPace;
        const w = cfg.session ? SESSION_W[sessionOf(min)] : 1;
        let slot = Math.min(remaining, evenPace * pace * w);
        if (vi === valid.length - 1) slot = remaining;   // última barra gasta todo
        if (slot > 0) { usdt += slot / price; mxn += slot; remaining -= slot; }
      }
      totals[k].mxn += mxn; totals[k].usdt += usdt; totals[k].buys += buys;
      perDay[k][date] = usdt > 0 ? mxn / usdt : null;
    }
  }

  // Trader (compra/vende en puntos clave) — causal sobre todas las barras
  const trader = runTrader(bars, prices, btcByTs, sig);

  // Calidad de señales
  const quality = {};
  for (let i = P.WARMUP; i < bars.length; i++) {
    const t = sig[i]?.tier; if (!t) continue;
    for (const h of P.HORIZONS) {
      const j = i + h; if (j >= bars.length) continue;
      const delta = (prices[j] - prices[i]) * 100;
      const key = `${t}|${h}`;
      (quality[key] ??= { n: 0, sum: 0, hits: 0 });
      quality[key].n++; quality[key].sum += delta; if (delta > 0) quality[key].hits++;
    }
  }

  return { sig, totals, perDay, days, trader, quality };
}

function runTrader(bars, prices, btcByTs, sig) {
  const T = P.TRADER;
  let usdt = 0, cost = 0, realized = 0, buys = 0, sells = 0;
  for (let i = P.WARMUP; i < bars.length; i++) {
    const price = prices[i], s = sig[i];
    const win = prices.slice(0, i + 1);
    const r = rsi(win, P.RSI_PERIOD);
    const z = zscore(prices.slice(Math.max(0, i - P.ZSCORE_WINDOW), i), price);
    const expensive = (z >= T.sellZ) || (r != null && r >= T.sellRsi);
    const avg = usdt > 0 ? cost / usdt : 0;
    const margin = usdt > 0 ? (price - avg) * 100 : 0;
    if (usdt > 0 && (margin >= T.takeProfit || (expensive && margin > 0))) {
      const sellMxn = Math.min(T.sellChunk, usdt * price);
      const sellUsdt = sellMxn / price;
      realized += sellMxn - avg * sellUsdt; cost -= avg * sellUsdt; usdt -= sellUsdt; sells++;
      if (usdt < 1e-6) { usdt = 0; cost = 0; }
    } else if (s?.tier === 'BUY' || s?.tier === 'STRONG_BUY') {
      const chunk = s.tier === 'STRONG_BUY' ? T.strongChunk : T.buyChunk;
      if (usdt * price + chunk <= T.maxPos) { usdt += chunk / price; cost += chunk; buys++; }
    }
  }
  // Valor de la posición abierta al último precio (no realizado)
  const last = prices[prices.length - 1];
  const unrealized = usdt > 0 ? usdt * last - cost : 0;
  return { realized, unrealized, openUsdt: usdt, avgCost: usdt > 0 ? cost / usdt : 0, buys, sells };
}

function report(bars, R) {
  const first = cdmxDate(bars[0].ts), last = cdmxDate(bars.at(-1).ts);
  const fmt = n => n.toLocaleString('es-MX', { maximumFractionDigits: 0 });
  const twapAvg = R.totals.twap.mxn / R.totals.twap.usdt;

  console.log('\n' + '═'.repeat(72));
  console.log('  BACKTEST DolarSignal — 7 estrategias · USD/MXN+BTC por hora');
  console.log(`  Periodo: ${first} → ${last}  (${bars.length} barras horarias)`);
  console.log(`  Presupuesto: $${fmt(P.DAILY_BUDGET_MXN)} MXN/día`);
  console.log('═'.repeat(72));

  console.log('\n  RANKING — centavos ganados por USDT vs compra pareja (TWAP)\n');
  console.log('  Estrategia        Precio prom.   Centavos/USDT   Ahorro 12m      # señales');
  console.log('  ' + '─'.repeat(68));
  const rows = Object.entries(ACC).map(([k, cfg]) => {
    const t = R.totals[k];
    const avg = t.usdt > 0 ? t.mxn / t.usdt : null;
    const cents = avg ? (twapAvg - avg) * 100 : 0;
    const saved = (cents / 100) * t.usdt;
    return { k, label: cfg.label, avg, cents, saved, buys: t.buys };
  });
  rows.sort((a, b) => b.cents - a.cents);
  for (const r of rows) {
    const tag = r.k === 'twap' ? ' (ref)' : r.k === rows.filter(x => x.k !== 'twap')[0].k ? ' ★' : '';
    console.log(`  ${(r.label + tag).padEnd(18)}${r.avg.toFixed(4).padStart(9)}     ${(r.cents >= 0 ? '+' : '') + r.cents.toFixed(4).padStart(8)}     $${fmt(r.saved).padStart(10)}     ${r.buys}`);
  }

  console.log('\n  TRADER (compra y vende en picos)');
  console.log('  ' + '─'.repeat(68));
  const t = R.trader;
  console.log(`  Ganancia realizada:   $${fmt(t.realized)} MXN  (${t.buys} compras / ${t.sells} ventas)`);
  console.log(`  Posición abierta:     ${fmt(t.openUsdt)} USDT @ ${t.avgCost.toFixed(4)}  (no realizado: $${fmt(t.unrealized)})`);

  console.log('\n  CALIDAD DE SEÑALES (¿subió el precio después?)');
  console.log('  Tier         Horizonte   #señales   Δ prom (¢)   % acierto');
  console.log('  ' + '─'.repeat(58));
  for (const tier of ['WATCH', 'BUY', 'STRONG_BUY']) {
    for (const h of P.HORIZONS) {
      const q = R.quality[`${tier}|${h}`]; if (!q) continue;
      console.log(`  ${tier.padEnd(12)} +${String(h).padStart(2)}h${' '.repeat(7)}${String(q.n).padStart(5)}    ${((q.sum / q.n) >= 0 ? '+' : '') + (q.sum / q.n).toFixed(2).padStart(6)}      ${(q.hits / q.n * 100).toFixed(0)}%`);
    }
  }
  console.log('\n  Nota: backtest HORARIO; el bot en vivo opera a nivel minuto y captura');
  console.log('  dips intra-hora que aquí no se ven → piso conservador. Ver README.\n');
  console.log('═'.repeat(72) + '\n');
}

// ── Main ──
const bars = await fetchYahoo();
const btcBars = await fetchBtcHourly(bars[0].ts, bars.at(-1).ts);
const btcByTs = new Map();
// Alinear BTC a la barra horaria más cercana de USD/MXN
{
  const btcSorted = btcBars.slice().sort((a, b) => a.ts - b.ts);
  let j = 0;
  for (const b of bars) {
    while (j + 1 < btcSorted.length && Math.abs(btcSorted[j + 1].ts - b.ts) <= Math.abs(btcSorted[j].ts - b.ts)) j++;
    if (btcSorted[j] && Math.abs(btcSorted[j].ts - b.ts) < 2 * 3600_000) btcByTs.set(b.ts, btcSorted[j].price);
  }
}
console.log(`BTC alineado a ${btcByTs.size}/${bars.length} barras`);
report(bars, run(bars, btcByTs));
