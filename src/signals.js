// Motor de señales de compra USDT/MXN.
// Combina: z-score de dip, RSI, banda de Bollinger, caída rápida estabilizada,
// compresión de la prima USDT vs spot, y ventanas de riesgo por eventos.

import { CONFIG } from './config.js';
import { minuteCloses, insertSignal } from './queries.js';
import { zscore, rsi, bollinger } from './indicators.js';
import { activeBlackout } from './calendar.js';

export async function evaluateSignal(now = Date.now()) {
  const since = now - Math.max(CONFIG.PREMIUM_WINDOW_MIN, CONFIG.ZSCORE_WINDOW_MIN) * 60_000;
  const [bitsoCloses, spotCloses] = await Promise.all([
    minuteCloses('bitso', since),
    minuteCloses('spot', since),
  ]);
  if (bitsoCloses.length < CONFIG.BOLLINGER_PERIOD + 1) return null; // aún calentando

  const closes = bitsoCloses.map(c => c.price);
  const price = closes[closes.length - 1];
  const reasons = [];
  let score = 0;

  // 1) Z-score del precio vs su media de la última hora (dip estadístico)
  const zWindow = closes.slice(-CONFIG.ZSCORE_WINDOW_MIN);
  const z = zscore(zWindow.slice(0, -1), price);
  if (z <= CONFIG.ZSCORE_DIP) { score += 2; reasons.push(`Dip fuerte: z-score ${z.toFixed(2)} (precio muy por debajo de su media 60m)`); }
  else if (z <= CONFIG.ZSCORE_SOFT) { score += 1; reasons.push(`Dip moderado: z-score ${z.toFixed(2)}`); }

  // 2) RSI en sobreventa
  const r = rsi(closes, CONFIG.RSI_PERIOD);
  if (r !== null) {
    if (r < CONFIG.RSI_EXTREME) { score += 2; reasons.push(`RSI extremo: ${r.toFixed(1)} (sobreventa fuerte)`); }
    else if (r < CONFIG.RSI_OVERSOLD) { score += 1; reasons.push(`RSI en sobreventa: ${r.toFixed(1)}`); }
  }

  // 3) Banda inferior de Bollinger
  const bb = bollinger(closes, CONFIG.BOLLINGER_PERIOD, CONFIG.BOLLINGER_K);
  if (bb && price <= bb.lower) { score += 1; reasons.push(`Precio en banda inferior de Bollinger (${bb.lower.toFixed(4)})`); }

  // 4) Caída rápida que se estabiliza (spike a la baja + piso)
  if (closes.length > CONFIG.DROP_LOOKBACK_MIN + 1) {
    const ago = closes[closes.length - 1 - CONFIG.DROP_LOOKBACK_MIN];
    const oneMinAgo = closes[closes.length - 2];
    const dropPct = (price - ago) / ago;
    if (dropPct <= CONFIG.DROP_PCT && price >= oneMinAgo) {
      score += 1;
      reasons.push(`Caída rápida de ${(dropPct * 100).toFixed(3)}% en ${CONFIG.DROP_LOOKBACK_MIN}m que se está estabilizando`);
    }
  }

  // 5) Prima USDT/MXN vs USD/MXN spot comprimida (USDT relativamente barato)
  let premium = null;
  if (spotCloses.length > 30) {
    const spotByMin = new Map(spotCloses.map(c => [c.bucket, c.price]));
    const premiums = [];
    let lastSpot = null;
    for (const c of bitsoCloses) {
      if (spotByMin.has(c.bucket)) lastSpot = spotByMin.get(c.bucket);
      if (lastSpot) premiums.push(c.price / lastSpot - 1);
    }
    if (premiums.length > 30) {
      premium = premiums[premiums.length - 1];
      const zPrem = zscore(premiums.slice(0, -1), premium);
      if (zPrem <= -1) {
        score += 1;
        reasons.push(`Prima USDT comprimida: ${(premium * 100).toFixed(3)}% vs spot (z ${zPrem.toFixed(2)}) — USDT relativamente barato`);
      }
    }
  }

  // Tier por score
  let tier = null;
  if (score >= CONFIG.SCORE_STRONG) tier = 'STRONG_BUY';
  else if (score >= CONFIG.SCORE_BUY) tier = 'BUY';
  else if (score >= CONFIG.SCORE_WATCH) tier = 'WATCH';
  if (!tier) return null;

  // Ventana de riesgo por evento high-impact: bloquea compras, alerta igual
  const blackout = activeBlackout(now);
  if (blackout && tier !== 'WATCH') {
    reasons.push(`⚠ BLOQUEADO: ventana de riesgo por "${blackout.name}"`);
    tier = 'BLOCKED';
  }

  const id = await insertSignal({ ts: now, tier, score, price, reasons });
  return { id, ts: now, tier, score, price, reasons, indicators: { z, rsi: r, bollinger: bb, premium } };
}

// Snapshot de indicadores para el dashboard (sin generar señal)
export async function indicatorSnapshot(now = Date.now()) {
  const since = now - CONFIG.PREMIUM_WINDOW_MIN * 60_000;
  const closes = (await minuteCloses('bitso', since)).map(c => c.price);
  if (closes.length < 5) return null;
  const price = closes[closes.length - 1];
  return {
    price,
    z: closes.length > CONFIG.BOLLINGER_PERIOD ? zscore(closes.slice(-CONFIG.ZSCORE_WINDOW_MIN, -1), price) : null,
    rsi: rsi(closes, CONFIG.RSI_PERIOD),
    bollinger: bollinger(closes, CONFIG.BOLLINGER_PERIOD, CONFIG.BOLLINGER_K),
  };
}
