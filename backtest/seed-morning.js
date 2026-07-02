// Siembra "Mañana IA" (morning_ai) desde el 16 jun: replay de ALTA FIDELIDAD.
// Usa los veredictos REALES de Opus ya grabados (tabla analysis, kind='analyst') y
// los precios RFQ reales por minuto. Compra solo en la ventana 07:00-12:00 CDMX:
// veredicto COMPRAR_AHORA→20% / COMPRAR_PARCIAL→8% (conf>=55, cooldown 5 min) +
// slots cada 30 min con reserva 0.4 y catch-up al final de la ventana.
// Presupuesto diario = el del TWAP de ese día. Solo días COMPLETOS (hoy lo hace el worker).
import { pool } from '../src/db.js';
import { CONFIG } from '../src/config.js';
import { ACCUMULATORS, AI_MIN_CONFIDENCE } from '../src/strategies.js';

const q = (s, p = []) => pool.query(s, p).then(r => r.rows);
const cfg = ACCUMULATORS.morning_ai;
const TZ = CONFIG.TIMEZONE;
const SLOT = CONFIG.TWAP_SLOT_MINUTES, CATCHUP = 4;
const W0 = cfg.windowStart, W1 = cfg.windowEnd;   // 420 → 720

const cdmxDate = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
const cdmxMin = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ts));
  return (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value);
};

async function main() {
  await pool.query("DELETE FROM trades WHERE strategy='morning_ai'");

  const rfq = await q("SELECT (ts/60000)*60000 m,(array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='rfq' GROUP BY m ORDER BY m");
  const verdicts = await q("SELECT ts, payload->>'stance' st, (payload->>'confidence')::int c FROM analysis WHERE kind='analyst' ORDER BY ts");
  const twap = await q("SELECT date, SUM(mxn) mxn FROM trades WHERE strategy='twap' GROUP BY date");
  const budgetByDate = {}; for (const r of twap) budgetByDate[r.date] = Number(r.mxn);

  // veredictos agrupados por minuto
  const vByMin = new Map();
  for (const v of verdicts) {
    const m = Math.floor(Number(v.ts) / 60000) * 60000;
    if (!vByMin.has(m)) vByMin.set(m, v);   // uno por minuto basta
  }

  // minutos RFQ por día (solo ventana)
  const days = {};
  for (const r of rfq) {
    const ts = Number(r.m), min = cdmxMin(ts);
    if (min < W0 || min >= W1) continue;
    const d = cdmxDate(ts);
    (days[d] ??= []).push({ ts, min, p: Number(r.p) });
  }

  const today = cdmxDate(Date.now());
  const rows = [];
  for (const [date, mins] of Object.entries(days)) {
    if (date >= today) continue;
    const budget = budgetByDate[date]; if (!budget) continue;
    let remaining = budget, lastBuy = 0, lastSlotKey = null;
    for (const { ts, min, p } of mins) {
      // 1) compra por veredicto real de Opus
      const v = vByMin.get(ts);
      if (v && remaining > 1 && ts - lastBuy >= CONFIG.SIGNAL_COOLDOWN_MS && Number(v.c) >= AI_MIN_CONFIDENCE) {
        const pct = v.st === 'COMPRAR_AHORA' ? cfg.aiNowPct : v.st === 'COMPRAR_PARCIAL' ? cfg.aiPartialPct : 0;
        if (pct > 0) {
          const amt = Math.min(budget * pct, remaining);
          rows.push([ts, date, 'morning_ai', 'ai', amt, p, amt / p]);
          remaining -= amt; lastBuy = ts;
        }
      }
      // 2) slot cada 30 min dentro de la ventana
      if (min % SLOT === 0) {
        const key = `${date}:${min}`;
        if (key !== lastSlotKey && remaining > 1) {
          lastSlotKey = key;
          const slotsLeft = Math.max(1, Math.ceil((W1 - min) / SLOT));
          const even = remaining / slotsLeft;
          let amt = slotsLeft <= 1 ? remaining : slotsLeft <= CATCHUP ? Math.min(remaining, even) : Math.min(remaining, even * cfg.slotPace);
          if (amt > 0) { rows.push([ts, date, 'morning_ai', 'slot', amt, p, amt / p]); remaining -= amt; }
        }
      }
    }
    // remanente por huecos de datos: al último precio de la ventana
    if (remaining > 1 && mins.length) {
      const { ts, p } = mins[mins.length - 1];
      rows.push([ts, date, 'morning_ai', 'slot', remaining, p, remaining / p]);
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    const c = rows.slice(i, i + 500);
    const vals = c.map((_, j) => `($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`).join(',');
    await pool.query(`INSERT INTO trades (ts,date,strategy,reason,mxn,price,usdt) VALUES ${vals}`, c.flat());
  }
  const chk = await q("SELECT date, COUNT(*) n, SUM(mxn) mxn, SUM(usdt) usdt FROM trades WHERE strategy='morning_ai' GROUP BY date ORDER BY date");
  console.log('Sembrado Mañana IA:');
  for (const r of chk) console.log('  ' + r.date + ': ' + r.n + ' ops · $' + Math.round(r.mxn).toLocaleString('es-MX') + ' · avg ' + (Number(r.mxn)/Number(r.usdt)).toFixed(4));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
