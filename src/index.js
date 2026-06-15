// DolarSignal — worker 24/7 (Railway): análisis y compra oportunista USDT/MXN (paper trading)
import { CONFIG, cdmxTime } from './config.js';
import { initSchema } from './db.js';
import { insertTick, insertNews } from './queries.js';
import { fetchBitso } from './sources/bitso.js';
import { fetchSpot } from './sources/spot.js';
import { fetchNews } from './sources/news.js';
import { evaluateSignal } from './signals.js';
import { onSignal, onSlotCheck } from './trader.js';
import { evaluateOutcomes } from './outcomes.js';
import { alertSignal, alertNews, sendAlert } from './alerts.js';
import { allEvents, upcomingEvents } from './calendar.js';
import { startServer } from './server.js';

const NEWS_ALERT_THRESHOLD = 4; // score mínimo para alertar una noticia
const startupTs = Date.now();
let lastBitsoPrice = null;
let lastAlertedTier = null;
let lastAlertTs = 0;

async function pollBitso() {
  try {
    const t = await fetchBitso();
    await insertTick({ ...t, source: 'bitso' });
    lastBitsoPrice = t.price;

    const signal = await evaluateSignal(t.ts);
    if (signal) {
      const trade = await onSignal(signal);
      // Alerta si sube de tier o pasaron >10 min desde la última
      const shouldAlert = signal.tier !== lastAlertedTier || t.ts - lastAlertTs > 10 * 60_000;
      if (shouldAlert) {
        await alertSignal(signal);
        lastAlertedTier = signal.tier;
        lastAlertTs = t.ts;
      }
      if (trade) {
        console.log(`💰 [${cdmxTime()}] Compra paper (${signal.tier}): $${trade.mxn.toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN @ ${trade.price.toFixed(4)} = ${trade.usdt.toFixed(2)} USDT`);
      }
    } else {
      lastAlertedTier = null;
    }
  } catch (err) {
    console.error(`[bitso] ${err.message}`);
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
    const trades = await onSlotCheck(Date.now(), lastBitsoPrice);
    for (const t of trades) {
      if (t.strategy === 'bot') {
        console.log(`🕐 [${cdmxTime()}] Slot ${t.strategy}: $${t.mxn.toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN @ ${t.price.toFixed(4)}`);
      }
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

  // Primer ciclo inmediato
  await Promise.allSettled([pollBitso(), pollSpot(), pollNews()]);

  setInterval(pollBitso, CONFIG.BITSO_POLL_MS);
  setInterval(pollSpot, CONFIG.SPOT_POLL_MS);
  setInterval(pollNews, CONFIG.NEWS_POLL_MS);
  setInterval(minuteTick, CONFIG.EVAL_POLL_MS);

  await sendAlert('🚀 DolarSignal iniciado', `Monitoreando USDT/MXN y USD/MXN. Dashboard en puerto ${CONFIG.PORT}.`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
