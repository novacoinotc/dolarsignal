// EJECUTOR REAL (tesorería) — la ÚNICA pieza del sistema que puede mover dinero.
//
// Política "CAPITÁN" (ganadora del torneo de 2,227 combinaciones sobre el periodo vivo,
// estructura corroborada por el backtest de 2 años):
//   ayer subió >+5¢  → hoy replica las compras de AGRESIVO IA (Opus decide)
//   ayer bajó <−5¢   → hoy replica AGRESIVO (dips mecánicos)
//   plano            → hoy replica TESORERO (reversión prudente)
// Replica = espeja cada compra paper de la estrategia activa, escalada al tope diario real.
//
// MODOS (env EXEC_MODE):
//   'off'  (default) — no hace NADA. Kill-switch.
//   'dry'  — ensayo: cotiza de verdad (Request a Quote) pero NUNCA convierte. Audita en real_trades.
//   'live' — dinero real: Request a Quote → Convert a Quote (POST /rfq/v1/conversions).
//
// SALVAGUARDAS: tope diario duro desde DB (sobrevive reinicios), sanidad de precio
// (prima vs público acotada), monto mínimo, cola serial (nunca 2 conversiones a la vez),
// auto-freno tras 3 fallas consecutivas (hasta reinicio manual), alerta de CADA operación.
import crypto from 'node:crypto';
import { CONFIG, tradingDate, cdmxTime } from './config.js';
import { cdmxDow, cdmxMinutes } from './strategies.js';
import { insertRealTrade, realSpent, prevDayChange } from './queries.js';

const BASE = 'https://api.bitso.com';
const QUOTES = '/rfq/v1/quotes';
const CONVERSIONS = '/rfq/v1/conversions';
const MAX_FAILS = 3;

let getPublicPrice = () => null;   // inyectado desde index.js (último precio bitso público)
let alertFn = async () => {};      // inyectado desde index.js (sendAlert)
// Auto-freno con enfriamiento: tras MAX_FAILS fallas seguidas pausa 60 min y REINTENTA
// solo (antes era permanente hasta reinicio → 5 días congelado en silencio el 3-ago
// cuando Bitso entró en mantenimiento justo tras reactivar).
const HALT_COOLDOWN_MS = 60 * 60_000;
let haltedUntil = 0;
let consecutiveFails = 0;
let queue = Promise.resolve();     // cola serial: una conversión a la vez
let regimeCache = { date: null, strategy: null, prevChg: null };

export const CAPITAN = { trendT: 5, up: 'aggressive_ai', down: 'aggressive', flat: 'tesorero' };

export function initExecutor({ publicPrice, alert }) {
  if (publicPrice) getPublicPrice = publicPrice;
  if (alert) alertFn = alert;
  const pol = CONFIG.EXEC_STRATEGY === 'capitan'
    ? `capitán ↑${CAPITAN.up} ↓${CAPITAN.down} =${CAPITAN.flat} (T${CAPITAN.trendT}¢)`
    : `espeja ${CONFIG.EXEC_STRATEGY}`;
  console.log(`   Ejecutor real: modo ${CONFIG.EXEC_MODE.toUpperCase()}` +
    (CONFIG.EXEC_MODE === 'off' ? '' : ` · tope $${CONFIG.EXEC_DAILY_CAP_MXN.toLocaleString('es-MX')}/día · ${pol}`));
}

function authHeader(method, path, body) {
  const nonce = Date.now().toString();
  const signature = crypto.createHmac('sha256', CONFIG.BITSO_API_SECRET)
    .update(nonce + method + path + body).digest('hex');
  return `Bitso ${CONFIG.BITSO_API_KEY}:${nonce}:${signature}`;
}

async function bitsoPost(path, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader('POST', path, payload) },
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  return j.payload || j;
}

// Estrategia activa HOY: fija (EXEC_STRATEGY) o por régimen del día previo ('capitan')
export async function activeStrategy(now = Date.now()) {
  if (CONFIG.EXEC_STRATEGY !== 'capitan') return { strategy: CONFIG.EXEC_STRATEGY, prevChg: null };
  const date = tradingDate(now);
  if (regimeCache.date !== date) {
    const prevChg = await prevDayChange(now);
    const s = prevChg == null ? CAPITAN.flat
      : prevChg > CAPITAN.trendT ? CAPITAN.up
      : prevChg < -CAPITAN.trendT ? CAPITAN.down
      : CAPITAN.flat;
    regimeCache = { date, strategy: s, prevChg };
    console.log(`🧭 [${cdmxTime(now)}] Capitán del día: ${s} (ayer ${prevChg == null ? '?' : prevChg.toFixed(1) + '¢'})`);
  }
  return regimeCache;
}

// Hook llamado por trader.js tras CADA compra paper. Decide si se espeja en real.
// Nunca lanza (un error aquí jamás debe romper el paper trading).
export function onPaperTrade(t) {
  if (CONFIG.EXEC_MODE === 'off') return;
  const now = Date.now();
  if (now < haltedUntil) return;   // en enfriamiento tras fallas — reintenta solo al expirar
  // ventana real: sin compras de viernes 16:00 → domingo 24:00 (finde caro; reanuda lunes 00:00)
  const dow = cdmxDow(now), hr = Math.floor(cdmxMinutes(now) / 60);
  if (dow === 0 || dow === 6 || (dow === 5 && hr >= CONFIG.EXEC_FRIDAY_CUTOFF_HOUR)) return;
  if (!t || t.reason === 'sell' || t.strategy === 'trader') return;
  queue = queue.then(() => mirror(t)).catch(err => console.error('[executor]', err.message));
}

async function mirror(t) {
  const now = Date.now();
  const { strategy } = await activeStrategy(now);
  if (t.strategy !== strategy) return;                       // solo la estrategia activa del día

  // escala: la proporción del paper ($25M) aplicada al tope real
  const scale = CONFIG.EXEC_DAILY_CAP_MXN / CONFIG.DAILY_BUDGET_MXN;
  await executeReal(Math.round(t.mxn * scale), t.strategy, t.reason);
}

// PACER de completado: si el día real va atrasado (fallas de Bitso, o el brazo del día
// ya terminó su paper y sus espejos fallaron), compra el faltante repartido por hora en
// la recta final (EXEC_PACER_START_HOUR→22h). Garantiza completar el cupo diario igual
// que las estrategias paper completan el suyo. No interfiere con la estrategia durante
// el día (solo actúa tarde, cuando ya no viene más volumen del espejo).
let lastPacerKey = null;
export function pacerTick(now = Date.now()) {
  if (CONFIG.EXEC_MODE === 'off' || Date.now() < haltedUntil) return;
  const dow = cdmxDow(now), hr = Math.floor(cdmxMinutes(now) / 60);
  if (dow === 0 || dow === 6 || (dow === 5 && hr >= CONFIG.EXEC_FRIDAY_CUTOFF_HOUR)) return;
  if (hr < CONFIG.EXEC_PACER_START_HOUR || hr >= 22) return;
  const key = `${tradingDate(now)}:${hr}`;
  if (key === lastPacerKey) return;                          // una vez por hora
  lastPacerKey = key;
  queue = queue.then(async () => {
    const date = tradingDate(now);
    const spent = await realSpent(date, CONFIG.EXEC_MODE);
    const left = CONFIG.EXEC_DAILY_CAP_MXN - spent;
    if (left < CONFIG.EXEC_MIN_MXN) return;
    const hoursLeft = 22 - hr;
    console.log(`⏱️ [${cdmxTime(now)}] Pacer: día atrasado ($${Math.round(spent).toLocaleString('es-MX')} de $${CONFIG.EXEC_DAILY_CAP_MXN.toLocaleString('es-MX')}) — completando`);
    await executeReal(Math.round(left / hoursLeft), 'pacer', 'pace');
  }).catch(err => console.error('[executor]', err.message));
}

async function executeReal(mxnWanted, stratLabel, reason) {
  const now = Date.now();
  const date = tradingDate(now);
  const already = await realSpent(date, CONFIG.EXEC_MODE);
  const capLeft = CONFIG.EXEC_DAILY_CAP_MXN - already;       // tope diario DURO (desde DB)
  if (capLeft < CONFIG.EXEC_MIN_MXN) return;                 // día completado
  // Bitso RFQ exige ≥$17,500 por cotización: sube al mínimo las compras chicas
  const mxn = Math.min(Math.max(mxnWanted, CONFIG.EXEC_MIN_MXN), capLeft);
  if (mxn < CONFIG.EXEC_MIN_MXN) return;

  const record = { ts: now, date, mode: CONFIG.EXEC_MODE, strategy: stratLabel, reason, mxn, price: 0, usdt: 0, quoteId: null, conversionId: null, status: '' };
  try {
    // 1) cotización real
    const quote = await bitsoPost(QUOTES, { source: 'mxn', target: 'usdt', source_amount: String(mxn) });
    const price = Number(quote.source_amount) / Number(quote.target_amount);
    record.price = price; record.usdt = Number(quote.target_amount); record.quoteId = quote.id || null;

    // 2) sanidad: la prima vs el precio público debe ser razonable
    const pub = getPublicPrice();
    const premium = pub ? (price - pub) * 100 : null;
    if (premium != null && premium > CONFIG.EXEC_MAX_PREMIUM_CENT) {
      record.status = `REJECTED_prima_${premium.toFixed(1)}c`;
      await insertRealTrade(record);
      console.log(`🛑 [${cdmxTime()}] Ejecutor RECHAZÓ compra: prima ${premium.toFixed(2)}¢ > ${CONFIG.EXEC_MAX_PREMIUM_CENT}¢`);
      return;
    }
    if (quote.can_confirm === false) {
      record.status = 'REJECTED_no_confirmable';
      await insertRealTrade(record);
      return;
    }

    if (CONFIG.EXEC_MODE === 'dry') {
      // ensayo: NO convierte — solo audita a qué precio habría comprado
      record.status = 'DRY';
      await insertRealTrade(record);
      console.log(`🧪 [${cdmxTime()}] ENSAYO compra real: $${mxn.toLocaleString('es-MX')} @ ${price.toFixed(4)} (${stratLabel}/${reason}) — no ejecutada`);
      consecutiveFails = 0;
      return;
    }

    // 3) LIVE: ejecuta la conversión (Convert a Quote) — AQUÍ se mueve dinero real
    const conv = await bitsoPost(CONVERSIONS, { quote_id: quote.id });
    record.conversionId = conv.id || null;
    record.status = conv.status || 'COMPLETED';
    await insertRealTrade(record);
    consecutiveFails = 0;
    console.log(`💵 [${cdmxTime()}] COMPRA REAL: $${mxn.toLocaleString('es-MX')} @ ${price.toFixed(4)} → ${record.usdt.toFixed(2)} USDT (${conv.status})`);
    await alertFn('💵 Compra REAL ejecutada',
      `$${mxn.toLocaleString('es-MX')} MXN @ ${price.toFixed(4)} → ${record.usdt.toFixed(2)} USDT\n` +
      `Estrategia: ${stratLabel} (${reason}) · Gastado hoy: $${(already + mxn).toLocaleString('es-MX')} de $${CONFIG.EXEC_DAILY_CAP_MXN.toLocaleString('es-MX')}`);
  } catch (err) {
    consecutiveFails++;
    record.status = `FAILED_${err.message.slice(0, 180)}`;
    await insertRealTrade(record).catch(() => {});
    console.error(`[executor] falla ${consecutiveFails}/${MAX_FAILS}: ${err.message}`);
    if (consecutiveFails >= MAX_FAILS) {
      haltedUntil = Date.now() + HALT_COOLDOWN_MS;   // pausa 60 min y reintenta solo
      consecutiveFails = 0;
      console.log(`🛑 [${cdmxTime()}] Auto-freno: ${MAX_FAILS} fallas seguidas — pausa 60 min y reintento automático`);
      await alertFn('🛑 Ejecutor en pausa 60 min (auto-freno)',
        `${MAX_FAILS} fallas consecutivas — reintento automático en 1 hora.\nÚltima: ${err.message.slice(0, 180)}`).catch(() => {});
    }
  }
}
