// DolarSignal — worker 24/7 (Railway): análisis y compra oportunista USDT/MXN (paper trading)
import { CONFIG, cdmxTime } from './config.js';
import { initSchema } from './db.js';
import { insertTick, insertNews } from './queries.js';
import { fetchBitso } from './sources/bitso.js';
import { fetchSpot } from './sources/spot.js';
import { fetchBtc } from './sources/btc.js';
import { fetchRfq } from './sources/rfq.js';
import { fetchNews } from './sources/news.js';
import { evaluateSignal, indicatorSnapshot } from './signals.js';
import { onSignal, onSlotCheck, onTraderTick } from './trader.js';
import { evaluateOutcomes } from './outcomes.js';
import { alertSignal, alertNews, sendAlert } from './alerts.js';
import { allEvents, upcomingEvents } from './calendar.js';
import { startServer } from './server.js';

const NEWS_ALERT_THRESHOLD = 4; // score mínimo para alertar una noticia
const startupTs = Date.now();
let lastBitsoPrice = null;
let lastRfqPrice = null;        // precio REAL al que nos vende Bitso (RFQ) — precio de ejecución
let lastAlertedTier = null;
let lastAlertTs = 0;

// Precio de ejecución del paper trading = RFQ real; si aún no hay, usa el público
const execPrice = () => lastRfqPrice || lastBitsoPrice;

async function pollBitso() {
  try {
    const t = await fetchBitso();
    await insertTick({ ...t, source: 'bitso' });
    lastBitsoPrice = t.price;

    const signal = await evaluateSignal(t.ts);
    const snapshot = await indicatorSnapshot(t.ts);

    if (signal) {
      const trades = await onSignal(signal, execPrice());   // ejecuta al precio RFQ real
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

    // Trader: compra/vende en puntos clave al precio RFQ real
    const action = await onTraderTick(t.ts, execPrice(), signal, snapshot);
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

// Precio real institucional (RFQ de Bitso) — SOLO LECTURA. Es el precio de
// ejecución del paper trading (al que de verdad nos vende Bitso).
async function pollRfq() {
  if (!CONFIG.BITSO_API_KEY) return;   // sin credenciales, se omite
  try {
    const t = await fetchRfq();
    lastRfqPrice = t.price;
    await insertTick({ ts: t.ts, source: 'rfq', price: t.price });
  } catch (err) {
    console.error(`[rfq] ${err.message}`);
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
      // Solo alertar noticias nuevas, de alto impacto y recientes (< 2h)
      const isRecent = Date.now() - item.ts < 2 * 3600_000;
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
    const trades = await onSlotCheck(Date.now(), execPrice());   // slots al precio RFQ real
    if (trades.length) {
      console.log(`🕐 [${cdmxTime()}] Slots: ${trades.length} estrategias compraron @ ${trades[0].price.toFixed(4)} (RFQ)`);
    }
    await evaluateOutcomes();
  } catch (err) {
    console.error(`[minute] ${err.message}`);
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

  setInterval(pollBitso, CONFIG.BITSO_POLL_MS);
  setInterval(pollSpot, CONFIG.SPOT_POLL_MS);
  setInterval(pollBtc, CONFIG.BTC_POLL_MS);
  setInterval(pollRfq, CONFIG.RFQ_POLL_MS);
  setInterval(pollNews, CONFIG.NEWS_POLL_MS);
  setInterval(minuteTick, CONFIG.EVAL_POLL_MS);

  await sendAlert('🚀 DolarSignal iniciado', `7 estrategias en paralelo · monitoreando USDT/MXN, USD/MXN, BTC y noticias. Puerto ${CONFIG.PORT}.`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
