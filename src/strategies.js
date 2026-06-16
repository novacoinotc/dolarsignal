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

// Plan del día para una estrategia: cuánto comprar y hasta qué minuto.
//  Las de fridayPreload: vie = $20M + finde; sáb/dom = $0 (ya precargado); resto = $20M.
export function dayPlan(cfg, now) {
  if (cfg.fridayPreload) {
    const dow = cdmxDow(now);
    if (dow === 5) return { budget: BASE_DAILY * (1 + WEEKEND_DAYS_SOLD), endMin: FRIDAY_CUTOFF_MIN };
    if (dow === 6 || dow === 0) return { budget: 0, endMin: 1440 };
  }
  return { budget: BASE_DAILY, endMin: 1440 };
}

export function sessionWeight(cfg, minutes) {
  return cfg.sessionAware ? SESSION_WEIGHT[sessionOf(minutes)] : 1;
}
