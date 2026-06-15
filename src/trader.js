// Paper trading: dos estrategias compran 20M MXN diarios en USDT.
//  - 'twap': referencia tonta — compra parejo cada 30 min (lo que haría una mesa sin bot)
//  - 'bot':  compra oportunista en señales (adelanta compras en dips) y rellena
//            el resto con slots para garantizar completar el presupuesto diario.
// La diferencia de precio promedio entre ambas = centavos que el bot le gana al mercado.

import { CONFIG, tradingDate } from './config.js';
import { insertTrade, spent } from './queries.js';

let lastSignalBuyTs = 0;
let lastSlotKey = null;

async function execute(strategy, reason, mxn, price, signalId = null, now = Date.now()) {
  if (mxn < 1) return null;
  const usdt = mxn / price;
  await insertTrade({ ts: now, date: tradingDate(now), strategy, reason, mxn, price, usdt, signalId });
  return { strategy, reason, mxn, price, usdt };
}

// Minutos transcurridos del día en CDMX
function cdmxMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.TIMEZONE, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(now));
  const h = Number(parts.find(p => p.type === 'hour').value) % 24;
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

// Cada minuto: ¿toca slot de compra (cada 30 min)?
export async function onSlotCheck(now, price) {
  if (!price) return [];
  const minutes = cdmxMinutes(now);
  if (minutes % CONFIG.TWAP_SLOT_MINUTES !== 0) return [];
  const key = `${tradingDate(now)}:${minutes}`;
  if (key === lastSlotKey) return [];
  lastSlotKey = key;

  const date = tradingDate(now);
  const remainingSlots = Math.max(1, Math.ceil((1440 - minutes) / CONFIG.TWAP_SLOT_MINUTES));
  const executed = [];

  for (const strategy of ['twap', 'bot']) {
    const remaining = CONFIG.DAILY_BUDGET_MXN - await spent(date, strategy);
    const amount = remaining / remainingSlots;
    const t = await execute(strategy, 'slot', amount, price, null, now);
    if (t) executed.push(t);
  }
  return executed;
}

// Compra oportunista cuando hay señal BUY / STRONG_BUY
export async function onSignal(signal) {
  if (signal.tier !== 'BUY' && signal.tier !== 'STRONG_BUY') return null;
  const now = signal.ts;
  if (now - lastSignalBuyTs < CONFIG.SIGNAL_COOLDOWN_MS) return null;

  const date = tradingDate(now);
  const remaining = CONFIG.DAILY_BUDGET_MXN - await spent(date, 'bot');
  if (remaining < 1) return null;

  const pct = signal.tier === 'STRONG_BUY' ? CONFIG.STRONG_BUY_PCT : CONFIG.SIGNAL_BUY_PCT;
  const amount = Math.min(CONFIG.DAILY_BUDGET_MXN * pct, remaining);
  const trade = await execute('bot', 'signal', amount, signal.price, signal.id, now);
  if (trade) lastSignalBuyTs = now;
  return trade;
}
