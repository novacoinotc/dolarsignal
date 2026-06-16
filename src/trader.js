// Motor de paper trading: corre TODAS las estrategias en paralelo sobre el
// mismo mercado real. Las acumuladoras (twap, bot, aggressive, sessions, friday,
// smart) compran $20M MXN/día; el trader compra y vende en puntos clave.

import { CONFIG, tradingDate } from './config.js';
import { insertTrade, spent, traderPosition } from './queries.js';
import {
  ACCUMULATORS, TRADER, dayPlan, sessionWeight, cdmxMinutes,
} from './strategies.js';

const CATCHUP_SLOTS = 4;           // slots finales donde se acelera al 100%
const lastSignalBuyTs = {};        // cooldown por estrategia
let lastSlotKey = null;
let lastTraderTs = 0;

async function execute(strategy, reason, mxn, price, signalId = null, now = Date.now()) {
  if (mxn < 1) return null;
  const usdt = mxn / price;
  await insertTrade({ ts: now, date: tradingDate(now), strategy, reason, mxn, price, usdt, signalId });
  return { strategy, reason, mxn, price, usdt };
}

// Cada minuto: slots de compra de relleno (cada 30 min) para las acumuladoras.
export async function onSlotCheck(now, price) {
  if (!price) return [];
  const minutes = cdmxMinutes(now);
  if (minutes % CONFIG.TWAP_SLOT_MINUTES !== 0) return [];
  const key = `${tradingDate(now)}:${minutes}`;
  if (key === lastSlotKey) return [];
  lastSlotKey = key;

  const date = tradingDate(now);
  const executed = [];

  for (const [name, cfg] of Object.entries(ACCUMULATORS)) {
    const plan = dayPlan(cfg, now);
    if (plan.budget < 1 || minutes > plan.endMin) continue;   // sin presupuesto o ventana cerrada
    const remaining = plan.budget - await spent(date, name);
    if (remaining < 1) continue;
    const slotsLeft = Math.max(1, Math.ceil((plan.endMin - minutes) / CONFIG.TWAP_SLOT_MINUTES));
    const evenPace = remaining / slotsLeft;
    const pace = slotsLeft <= CATCHUP_SLOTS ? 1 : cfg.slotPace;
    const amount = Math.min(remaining, evenPace * pace * sessionWeight(cfg, minutes));
    const t = await execute(name, 'slot', amount, price, null, now);
    if (t) executed.push(t);
  }
  return executed;
}

// Compra oportunista en señal BUY / STRONG_BUY para las acumuladoras que la usan.
// execPrice = precio REAL de ejecución (RFQ de Bitso); la señal se detecta con el
// precio público pero la compra se registra al precio que de verdad pagamos.
export async function onSignal(signal, execPrice) {
  if (signal.tier !== 'BUY' && signal.tier !== 'STRONG_BUY') return [];
  const price = execPrice || signal.price;
  const now = signal.ts;
  const minutes = cdmxMinutes(now);
  const date = tradingDate(now);
  const executed = [];

  for (const [name, cfg] of Object.entries(ACCUMULATORS)) {
    const pct = signal.tier === 'STRONG_BUY' ? cfg.strongBuyPct : cfg.signalBuyPct;
    if (pct <= 0) continue;
    if (now - (lastSignalBuyTs[name] || 0) < CONFIG.SIGNAL_COOLDOWN_MS) continue;
    const plan = dayPlan(cfg, now);
    if (plan.budget < 1 || minutes > plan.endMin) continue;
    const remaining = plan.budget - await spent(date, name);
    if (remaining < 1) continue;
    const amount = Math.min(plan.budget * pct, remaining);
    const trade = await execute(name, 'signal', amount, price, signal.id, now);
    if (trade) { lastSignalBuyTs[name] = now; executed.push(trade); }
  }
  return executed;
}

// Trader: compra barato y VENDE caro en puntos clave. Mide ganancia realizada.
//  - signal (BUY/STRONG): compra si no excede el tope de inventario.
//  - snapshot caro (z alto o RSI alto) y posición con ganancia: vende y realiza.
export async function onTraderTick(now, price, signal, snapshot) {
  if (!price) return null;
  if (now - lastTraderTs < CONFIG.SIGNAL_COOLDOWN_MS) return null;

  const pos = await traderPosition();   // { usdt, avgCost }
  let action = null;

  // ¿Vender? toma de ganancia: el precio subió lo suficiente sobre el costo,
  // o está estadísticamente caro (z/RSI altos) teniendo cualquier margen positivo.
  const marginCentavos = pos.usdt > 0 ? (price - pos.avgCost) * 100 : 0;
  const expensive = snapshot && ((snapshot.z != null && snapshot.z >= TRADER.sellZ) ||
                                 (snapshot.rsi != null && snapshot.rsi >= TRADER.sellRsi));
  if (pos.usdt > 0 && (marginCentavos >= TRADER.takeProfitCentavos || (expensive && marginCentavos > 0))) {
    const sellMxn = Math.min(TRADER.sellChunk, pos.usdt * price);
    action = await execute('trader', 'sell', sellMxn, price, null, now);
  }
  // ¿Comprar? hay señal de dip y no excedemos el tope
  else if ((signal?.tier === 'BUY' || signal?.tier === 'STRONG_BUY')) {
    const posMxn = pos.usdt * price;
    const chunk = signal.tier === 'STRONG_BUY' ? TRADER.strongBuyChunk : TRADER.buyChunk;
    if (posMxn + chunk <= TRADER.maxPositionMxn) {
      action = await execute('trader', 'buy', chunk, price, signal.id, now);
    }
  }

  if (action) lastTraderTs = now;
  return action;
}
