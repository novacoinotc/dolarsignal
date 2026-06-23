// DolarSignal — worker 24/7 (Railway): análisis y compra oportunista USDT/MXN (paper trading)
import { CONFIG, cdmxTime } from './config.js';
import { initSchema } from './db.js';
import { insertTick, insertNews } from './queries.js';
import { fetchBitso } from './sources/bitso.js';
import { fetchSpot } from './sources/spot.js';
import { fetchBtc } from './sources/btc.js';
import { fetchRfqBuy, fetchRfqSell } from './sources/rfq.js';
import { fetchNews } from './sources/news.js';
import { evaluateSignal, indicatorSnapshot } from './signals.js';
import { onSignal, onSlotCheck, onTraderTick, onVerdict, onMomentum } from './trader.js';
import { evaluateOutcomes } from './outcomes.js';
import { alertSignal, alertNews, sendAlert } from './alerts.js';
import { allEvents, upcomingEvents } from './calendar.js';
import { buildAnalysisContext, insertAnalysis, latestAnalysis } from './queries.js';
import { runScout, runAnalyst, aiEnabled } from './analyst.js';
import { startServer } from './server.js';

const NEWS_ALERT_THRESHOLD = 4; // score mínimo para alertar una noticia
const startupTs = Date.now();
let lastBitsoPrice = null;
let lastRfqPrice = null;        // precio REAL de COMPRA (RFQ) — ejecución de compras
let lastRfqSellPrice = null;    // precio REAL de VENTA (RFQ) — ejecución de ventas del trader
let lastAlertedTier = null;
let lastAlertTs = 0;

// Precios de ejecución del paper trading = RFQ real; si aún no hay, usa el público
const buyPrice = () => lastRfqPrice || lastBitsoPrice;
const sellPrice = () => lastRfqSellPrice || lastBitsoPrice;

let lastAnalystTs = 0;   // última vez que corrió Opus (control de costo)
let lastCatalystTs = 0;  // última noticia de alto impacto (catalizador para Momentum)
const newsCatalyst = () => Date.now() - lastCatalystTs < 30 * 60_000;

async function pollBitso() {
  try {
    const t = await fetchBitso();
    await insertTick({ ...t, source: 'bitso' });
    lastBitsoPrice = t.price;

    const signal = await evaluateSignal(t.ts);
    const snapshot = await indicatorSnapshot(t.ts);

    if (signal) {
      const trades = await onSignal(signal, buyPrice());   // ejecuta al precio RFQ real de compra
      // Alerta si sube de tier o pasaron >10 min desde la última
      const shouldAlert = signal.tier !== lastAlertedTier || t.ts - lastAlertTs > 10 * 60_000;
      if (shouldAlert) {
        await alertSignal(signal);
        lastAlertedTier = signal.tier;
        lastAlertTs = t.ts;
      }
      const botTrade = trades.find(x => x.strategy === 'smart') || trades[0];
      if (botTrade) {
        console.log(`💰 [${cdmxTime()}] ${trades.length} compras (${signal.tier}) @ ${botTrade.price.toFixed(4)} (RFQ)`);
      }
    } else {
      lastAlertedTier = null;
    }

    // Momentum: anticipa la subida (compra fuerte si z alto / noticia / BTC cae)
    const mom = await onMomentum(t.ts, snapshot?.z, snapshot?.btcZ, newsCatalyst(), buyPrice());
    if (mom.length) console.log(`🚀 [${cdmxTime()}] Momentum compró @ ${mom[0].price.toFixed(4)}`);

    // Trader: compra al precio RFQ de compra, vende al precio RFQ de venta (real)
    const action = await onTraderTick(t.ts, buyPrice(), sellPrice(), signal, snapshot);
    if (action) {
      console.log(`💱 [${cdmxTime()}] Trader ${action.reason.toUpperCase()}: $${action.mxn.toLocaleString('es-MX', { maximumFractionDigits: 0 })} @ ${action.price.toFixed(4)}`);
    }
  } catch (err) {
    console.error(`[bitso] ${err.message}`);
  }
}

async function pollBtc() {
  try {
    const t = await fetchBtc();
    await insertTick({ ts: t.ts, source: 'btc', price: t.price });
  } catch (err) {
    console.error(`[btc] ${err.message}`);
  }
}

// Precio real institucional (RFQ de Bitso) — SOLO LECTURA. Cotiza COMPRA y VENTA;
// son los precios de ejecución del paper trading (a los que de verdad opera Bitso).
async function pollRfq() {
  if (!CONFIG.BITSO_API_KEY) return;   // sin credenciales, se omite
  try {
    const b = await fetchRfqBuy();
    lastRfqPrice = b.price;
    await insertTick({ ts: b.ts, source: 'rfq', price: b.price });
  } catch (err) {
    console.error(`[rfq buy] ${err.message}`);
  }
  try {
    const s = await fetchRfqSell();
    lastRfqSellPrice = s.price;
    await insertTick({ ts: s.ts, source: 'rfq_sell', price: s.price });
  } catch (err) {
    console.error(`[rfq sell] ${err.message}`);
  }
}

async function pollSpot() {
  try {
    const t = await fetchSpot();
    await insertTick({ ts: t.ts, source: 'spot', price: t.price });
  } catch (err) {
    console.error(`[spot] ${err.message}`);
  }
}

async function pollNews() {
  try {
    const items = await fetchNews();
    for (const item of items) {
      const isNew = await insertNews(item);
      const isRecent = Date.now() - item.ts < 2 * 3600_000;
      // Noticia de alto impacto reciente = catalizador para Momentum
      if (isNew && isRecent && item.score >= 4.5) lastCatalystTs = Date.now();
      // Alerta de noticias nuevas, de alto impacto
      if (isNew && isRecent && item.score >= NEWS_ALERT_THRESHOLD && Date.now() - startupTs > 60_000) {
        await alertNews(item);
      }
    }
  } catch (err) {
    console.error(`[news] ${err.message}`);
  }
}

async function minuteTick() {
  try {
    const trades = await onSlotCheck(Date.now(), buyPrice());   // slots al precio RFQ real
    if (trades.length) {
      console.log(`🕐 [${cdmxTime()}] Slots: ${trades.length} estrategias compraron @ ${trades[0].price.toFixed(4)} (RFQ)`);
    }
    await evaluateOutcomes();
  } catch (err) {
    console.error(`[minute] ${err.message}`);
  }
}

// Agente de IA: el scout (Haiku) revisa cada minuto; si ve algo, escala a Opus.
async function agentTick() {
  if (!aiEnabled() || Date.now() - startupTs < 60_000) return;
  try {
    const now = Date.now();
    const ctx = await buildAnalysisContext(now);

    const scout = await runScout(ctx);
    await insertAnalysis({ ts: now, kind: 'scout', model: CONFIG.SCOUT_MODEL, summary: scout.reason, payload: scout });

    // ¿Escalar a Opus? Por urgencia del scout, por STRONG_BUY/ventana de riesgo,
    // o porque ya pasó demasiado tiempo desde el último análisis profundo.
    const sinceAnalyst = now - lastAnalystTs;
    const hardTrigger = scout.urgency === 'high' || (ctx.lastStrongMin != null && ctx.lastStrongMin <= 1) || ctx.blackout;
    const softTrigger = scout.interesting && scout.urgency !== 'low';
    const escalate = sinceAnalyst >= CONFIG.ANALYST_MAX_GAP_MS
      || (hardTrigger && sinceAnalyst >= 60_000)
      || (softTrigger && sinceAnalyst >= CONFIG.ANALYST_MIN_GAP_MS);

    if (escalate) {
      const verdict = await runAnalyst(ctx, scout.reason);
      lastAnalystTs = now;
      await insertAnalysis({ ts: now, kind: 'analyst', model: CONFIG.ANALYST_MODEL, summary: verdict.headline, payload: verdict });
      console.log(`🤖 [${cdmxTime()}] Opus: ${verdict.stance} (${verdict.confidence}%) — ${verdict.headline}`);
      // Las gemelas IA compran según este veredicto (al precio RFQ real)
      const aiTrades = await onVerdict(verdict, buyPrice());
      if (aiTrades.length) {
        console.log(`🤖💰 [${cdmxTime()}] ${aiTrades.length} compras IA (${verdict.stance}) @ ${aiTrades[0].price.toFixed(4)}`);
      }
      if (verdict.stance === 'COMPRAR_AHORA' && verdict.confidence >= 70) {
        await sendAlert(`🤖 Análisis IA: ${verdict.stance} (${verdict.confidence}%)`, verdict.headline + '\n\n' + verdict.reasoning);
      }
    } else if (scout.interesting) {
      console.log(`👀 [${cdmxTime()}] Scout (${scout.urgency}): ${scout.reason}`);
    }
  } catch (err) {
    console.error(`[agent] ${err.message}`);
  }
}

async function main() {
  console.log('🚀 DolarSignal — bot de compra oportunista USDT/MXN');
  console.log(`   Fondo paper trading: $${CONFIG.DAILY_BUDGET_MXN.toLocaleString('es-MX')} MXN/día`);

  await initSchema();
  console.log('   Base de datos lista (Postgres)');

  console.log(`   Calendario económico: ${allEvents().length} eventos cargados`);
  const next = upcomingEvents()[0];
  if (next) console.log(`   Próximo evento: ${next.name} (${new Date(next.ts).toLocaleString('es-MX', { timeZone: CONFIG.TIMEZONE })})`);

  startServer();

  // Primer ciclo inmediato (BTC primero para que la señal lo tenga disponible)
  await Promise.allSettled([pollBtc(), pollSpot(), pollNews(), pollRfq()]);
  await pollBitso();

  console.log(`   Agente IA: ${aiEnabled() ? `scout ${CONFIG.SCOUT_MODEL} + analista ${CONFIG.ANALYST_MODEL}` : 'desactivado (falta ANTHROPIC_API_KEY)'}`);

  setInterval(pollBitso, CONFIG.BITSO_POLL_MS);
  setInterval(pollSpot, CONFIG.SPOT_POLL_MS);
  setInterval(pollBtc, CONFIG.BTC_POLL_MS);
  setInterval(pollRfq, CONFIG.RFQ_POLL_MS);
  setInterval(pollNews, CONFIG.NEWS_POLL_MS);
  setInterval(minuteTick, CONFIG.EVAL_POLL_MS);
  if (aiEnabled()) setInterval(agentTick, CONFIG.SCOUT_POLL_MS);

  await sendAlert('🚀 DolarSignal iniciado', `7 estrategias + agente IA · monitoreando USDT/MXN, USD/MXN, BTC y noticias. Puerto ${CONFIG.PORT}.`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
