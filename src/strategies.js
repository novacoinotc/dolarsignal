// Definición declarativa del laboratorio de estrategias de paper trading.
// Todas acumulan ~$20M MXN/día (las de viernes redistribuyen entre días, pero
// el TOTAL semanal es el mismo: 7 × $20M), salvo 'trader' que compra y vende.

import { CONFIG } from './config.js';

export const BASE_DAILY = CONFIG.DAILY_BUDGET_MXN;     // $20M MXN/día
export const WEEKEND_DAYS_SOLD = 2;                    // venden sáb y dom
export const FRIDAY_CUTOFF_MIN = 14 * 60 + 30;         // 14:30 CDMX

// Ventanas de sesión (hora CDMX, GMT-6). Aproximadas; se afinan con datos.
//  europea   02:00–08:00  (madrugada MX: Londres/Frankfurt — movimientos interesantes)
//  americana 08:00–15:00  (NY + México: máxima liquidez para el MXN)
//  otros     15:00–02:00  (tarde-noche + Asia: poca liquidez)
export function sessionOf(minutes) {
  if (minutes >= 120 && minutes < 480) return 'europea';
  if (minutes >= 480 && minutes < 900) return 'americana';
  return 'otros';
}

const SESSION_WEIGHT = { europea: 1.3, americana: 1.4, otros: 0.5 };

// Estrategias de ACUMULACIÓN (compran, no venden).
//  slotPace      ritmo base de compra de relleno (<1 = guarda reserva)
//  signalBuyPct  % del presupuesto diario que compra en señal BUY
//  strongBuyPct  % en señal STRONG_BUY
//  sessionAware  pondera el relleno por sesión (más en europea/americana)
//  fridayPreload pre-carga el fin de semana el viernes antes del cutoff
export const ACCUMULATORS = {
  // ── Mecánicas: disparan compras oportunistas con las señales matemáticas ──
  twap:        { label: 'Pareja (TWAP)', color: '#8b949e', slotPace: 1.0, signalBuyPct: 0,    strongBuyPct: 0,    sessionAware: false, fridayPreload: false },
  bot:         { label: 'Cauteloso',     color: '#3fb950', slotPace: 1.0, signalBuyPct: 0.02, strongBuyPct: 0.05, sessionAware: false, fridayPreload: false },
  aggressive:  { label: 'Agresivo',      color: '#f85149', slotPace: 0.4, signalBuyPct: 0.08, strongBuyPct: 0.20, sessionAware: false, fridayPreload: false },
  sessions:    { label: 'Sesiones',      color: '#a371f7', slotPace: 0.6, signalBuyPct: 0.05, strongBuyPct: 0.12, sessionAware: true,  fridayPreload: false },
  friday:      { label: 'Viernes',       color: '#d29922', slotPace: 1.0, signalBuyPct: 0.02, strongBuyPct: 0.05, sessionAware: false, fridayPreload: true  },
  smart:       { label: 'Inteligente',   color: '#58a6ff', slotPace: 0.4, signalBuyPct: 0.08, strongBuyPct: 0.20, sessionAware: true,  fridayPreload: true  },
  // ── Gemelas IA: misma receta de tamaño/timing, pero las compras oportunistas
  //    las dispara el VEREDICTO de Opus (COMPRAR_AHORA/PARCIAL), no las matemáticas.
  bot_ai:        { label: 'Cauteloso IA',   color: '#56d364', ai: true, slotPace: 1.0, signalBuyPct: 0, strongBuyPct: 0, aiPartialPct: 0.02, aiNowPct: 0.05, sessionAware: false, fridayPreload: false },
  aggressive_ai: { label: 'Agresivo IA',    color: '#ffa198', ai: true, slotPace: 0.4, signalBuyPct: 0, strongBuyPct: 0, aiPartialPct: 0.08, aiNowPct: 0.20, sessionAware: false, fridayPreload: false },
  smart_ai:      { label: 'Inteligente IA', color: '#d2a8ff', ai: true, slotPace: 0.4, signalBuyPct: 0, strongBuyPct: 0, aiPartialPct: 0.08, aiNowPct: 0.20, sessionAware: true,  fridayPreload: true  },
  // ── Momentum: ANTICIPA la subida. Compra fuerte cuando el precio viene subiendo
  //    (z-score positivo), hay noticia de alto impacto, o BTC se cae (risk-off → dólar↑).
  //    Lo opuesto a comprar el dip. Determinista (igual en vivo y en backtest).
  momentum:      { label: 'Momentum regla', color: '#ff7b00', momentum: true, slotPace: 0.4, signalBuyPct: 0, strongBuyPct: 0,
                   momZBuy: 1.0, momZStrong: 2.0, momBuyPct: 0.08, momStrongPct: 0.20, momNews: 4.5, momBtcZ: -1.5,
                   sessionAware: false, fridayPreload: false },
  // Momentum decidido por OPUS (anticipa la subida con criterio de IA, no con regla fija)
  momentum_opus: { label: 'Momentum Opus', color: '#ff4da6', momentumOpus: true, slotPace: 0.4, signalBuyPct: 0, strongBuyPct: 0,
                   momPct: 0.08, momFuertePct: 0.20, sessionAware: false, fridayPreload: false },
  // Ventana MATUTINA: compra todo entre 7am-12pm CDMX (backtest: única ventana robusta
  // en ambas mitades del periodo, con mejor peor-día que la madrugada) + sizing de Opus.
  morning_ai:    { label: 'Mañana IA', color: '#2dd4bf', ai: true, slotPace: 0.4, signalBuyPct: 0, strongBuyPct: 0,
                   aiPartialPct: 0.08, aiNowPct: 0.20, windowStart: 7 * 60, windowEnd: 12 * 60,
                   sessionAware: false, fridayPreload: false },
  // PRO: el destilado del backtest unificado — ventana matutina 7-12h + sizing por el
  // cerebro MOMENTUM de Opus (el único con discriminación real; compra menos a ciegas
  // que el analista). La variante con ventana nocturna salió PEOR: se excluye.
  pro_ai:        { label: 'Pro IA', color: '#eab308', momentumOpus: true, slotPace: 0.4, signalBuyPct: 0, strongBuyPct: 0,
                   momPct: 0.06, momFuertePct: 0.15, windowStart: 7 * 60, windowEnd: 12 * 60,
                   sessionAware: false, fridayPreload: false },
  // HÍBRIDO — la receta ganadora del backtest de 2 años CALIBRADO AL NEGOCIO
  // (vs refondeo real de operadores 8-22h: +0.176¢/día, 57% días, casi neutro al régimen):
  // dips por z horario dentro de 8am-10pm (z<=-1→10%, z<=-2→20%), madrugada SOLO dips
  // fuertes (z<=-2→20%), diferir cuando sube (z>=+1), completar al cierre 10pm.
  // Maneja su propia lógica horaria (onHybridHour); excluida de los slots genéricos.
  hybrid:        { label: 'Híbrido', color: '#22d3ee', hybrid: true, slotPace: 0, signalBuyPct: 0, strongBuyPct: 0,
                   sessionAware: false, fridayPreload: false },
  // TESORERO — ganador del mega-grid walk-forward de 2 años (train +0.261 / val +0.253 ¢/día).
  // Regla de régimen con el DÍA PREVIO: ayer subió >+5¢ → hoy ritmo parejo estilo operadores
  // (sin heroísmos); ayer bajó <−5¢ → reversión total; plano → reversión a media intensidad.
  // Corre en shadow (paper, RFQ real, viernes/findes incluidos) para validar el backtest.
  tesorero:      { label: 'Tesorero', color: '#c084fc', tesorero: true, slotPace: 0, signalBuyPct: 0, strongBuyPct: 0,
                   sessionAware: false, fridayPreload: false },
};

// Parámetros del Híbrido (espejo exacto del backtest business-2y.js)
export const HYBRID = {
  zStrong: -2, zDip: -1, zDefer: 1,
  strongPct: 0.20, dipPct: 0.10, pace: 0.4,
  nightEnd: 8,      // 00-08h: solo dips fuertes
  endHour: 22,      // completa el presupuesto a las 10pm (cierre de operación)
  finalHours: 3,    // recta final: ritmo parejo garantiza completar
};

// Parámetros del Tesorero (espejo exacto de backtest/switcher-refine.js, política ganadora
// "up→OPS dn→REV flat→REVLIGHT" T=5¢ lookback=1 día; motor REV: z−1→10%, z−2→30%,
// diferir z≥1.5, pace 0.5, madrugada solo z≤−2, completa 22h)
export const TESORERO = {
  trendT: 5,                          // ¢: umbral del cambio del día previo
  zStrong: -2, zDip: -1, zDefer: 1.5,
  strongPct: 0.30, dipPct: 0.10, pace: 0.5,
  lightFactor: 0.5,                   // modo plano: chunks a la mitad (REVLIGHT ejecutable)
  nightEnd: 8, endHour: 22, finalHours: 3,
};

// Confianza mínima de Opus para que las gemelas IA actúen sobre un veredicto
export const AI_MIN_CONFIDENCE = 55;

// Configuración del trader (compra barato, toma ganancia al subir).
export const TRADER = {
  label: 'Trader', color: '#ff7b72',
  buyChunk: 1_000_000, strongBuyChunk: 2_000_000,
  sellChunk: 1_500_000,
  maxPositionMxn: 8_000_000,        // tope de inventario especulativo
  takeProfitCentavos: 4,            // toma ganancia cuando el precio sube +4¢ sobre el costo
  sellZ: 1.5, sellRsi: 70,          // venta extra si el precio está estadísticamente caro
};

// Día de la semana en CDMX: 0=domingo … 6=sábado
export function cdmxDow(now) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.TIMEZONE, weekday: 'short' }).format(new Date(now));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

// Minutos transcurridos del día en CDMX
export function cdmxMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.TIMEZONE, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(now));
  const h = Number(parts.find(p => p.type === 'hour').value) % 24;
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

// Plan del día para una estrategia: cuánto comprar y en qué ventana [startMin, endMin].
//  Las de fridayPreload: vie = presupuesto + finde; sáb/dom = $0 (ya precargado).
//  Las de ventana (windowStart/windowEnd): solo compran dentro de su ventana horaria.
export function dayPlan(cfg, now) {
  if (cfg.fridayPreload) {
    const dow = cdmxDow(now);
    if (dow === 5) return { budget: BASE_DAILY * (1 + WEEKEND_DAYS_SOLD), startMin: 0, endMin: FRIDAY_CUTOFF_MIN };
    if (dow === 6 || dow === 0) return { budget: 0, startMin: 0, endMin: 1440 };
  }
  if (cfg.windowStart != null) {
    return { budget: BASE_DAILY, startMin: cfg.windowStart, endMin: cfg.windowEnd };
  }
  return { budget: BASE_DAILY, startMin: 0, endMin: 1440 };
}

export function sessionWeight(cfg, minutes) {
  return cfg.sessionAware ? SESSION_WEIGHT[sessionOf(minutes)] : 1;
}
