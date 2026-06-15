// Calendario económico — data/calendar.json se importa estáticamente para que
// funcione igual en el worker (Railway) y en las funciones de Vercel.
// Editar el JSON requiere redeploy/reinicio.
import calendarData from '../data/calendar.json' with { type: 'json' };
import { CONFIG } from './config.js';

const events = calendarData
  .map(e => ({ ...e, ts: Date.parse(e.date) }))
  .filter(e => !Number.isNaN(e.ts))
  .sort((a, b) => a.ts - b.ts);

export function allEvents() {
  return events;
}

// ¿Estamos dentro de una ventana de riesgo por evento high-impact?
export function activeBlackout(now = Date.now()) {
  const before = CONFIG.EVENT_BLACKOUT_BEFORE_MIN * 60_000;
  const after = CONFIG.EVENT_BLACKOUT_AFTER_MIN * 60_000;
  return events.find(e =>
    e.impact === 'high' && now >= e.ts - before && now <= e.ts + after
  ) || null;
}

export function upcomingEvents(now = Date.now(), limit = 8) {
  return events.filter(e => e.ts > now - 60 * 60_000).slice(0, limit);
}
