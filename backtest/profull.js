// Backtest del modelo "PRO FULL" — lo mejor de todos los modelos, unificado:
//   · Núcleo matutino 07-12h (única ventana robusta) con slots + reserva 0.4
//   · Ventana nocturna 00-04h SOLO oportunista (compra si Opus-momentum dice FUERTE)
//   · Sizing por el cerebro momentum de Opus (el único con discriminación real)
//   · Bear guard: si NO_COMPRAR activo, difiere el remanente al resto del día (TWAP tail)
// Replay determinista sobre datos reales: precios RFQ por minuto + veredictos momentum
// grabados (disponibles desde 2026-06-24). Compara vs resultados REALES de las demás
// estrategias en LOS MISMOS días. 3 variantes para aislar componentes.
import { pool } from '../src/db.js';
import { CONFIG } from '../src/config.js';

const q = (s, p = []) => pool.query(s, p).then(r => r.rows);
const TZ = CONFIG.TIMEZONE;
const cdmxDate = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
const cdmxMin = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ts));
  return (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value);
};

const VARIANTS = {
  'PRO FULL':        { night: true,  bearGuard: true  },
  'Solo mañana+guard': { night: false, bearGuard: true  },
  'Mañana sin guard':  { night: false, bearGuard: false },
};
const P = { nightCap: 0.30, nightChunk: 0.10, morFuerte: 0.15, morCompra: 0.06, pace: 0.4, catchup: 4, conf: 55 };

async function main() {
  const rfq = await q("SELECT (ts/60000)*60000 m,(array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='rfq' GROUP BY m ORDER BY m");
  const mv = await q("SELECT ts, payload->>'action' a, (payload->>'confidence')::int c FROM analysis WHERE kind='momentum' ORDER BY ts");
  const strat = await q("SELECT date, strategy, SUM(mxn) mxn, SUM(usdt) usdt FROM trades WHERE strategy != 'trader' GROUP BY date, strategy");

  // organizar
  const days = {};
  for (const r of rfq) { const ts = Number(r.m); const d = cdmxDate(ts); (days[d] ??= []).push({ ts, min: cdmxMin(ts), p: Number(r.p) }); }
  const verd = mv.map(v => ({ ts: Number(v.ts), a: v.a, c: Number(v.c) }));
  const sByDate = {};
  for (const r of strat) (sByDate[r.date] ??= {})[r.strategy] = Number(r.mxn) / Number(r.usdt);

  const today = cdmxDate(Date.now());
  const first = cdmxDate(verd[0].ts);                      // primer día con veredictos momentum
  const dates = Object.keys(days).filter(d => d > first && d < today).sort();
  console.log('Periodo de backtest (días completos con veredictos momentum):', dates[0], '→', dates.at(-1), '(' + dates.length + ' días)');

  // veredicto activo en un ts (el último en los 30 min previos)
  const activeVerdict = ts => { let out = null; for (const v of verd) { if (v.ts > ts) break; if (ts - v.ts <= 30 * 60000) out = v; } return out; };
  // veredictos dentro de un minuto exacto
  const vByMin = new Map(); for (const v of verd) { const m = Math.floor(v.ts / 60000) * 60000; if (!vByMin.has(m)) vByMin.set(m, v); }

  const results = {}; for (const k of Object.keys(VARIANTS)) results[k] = [];
  for (const date of dates) {
    const mins = days[date]; const budget = 25_000_000;
    const twapAvg = sByDate[date]?.twap; if (!twapAvg) continue;
    for (const [name, V] of Object.entries(VARIANTS)) {
      let remaining = budget, mxn = 0, usdt = 0, lastBuy = 0, nightSpent = 0, lastSlot = null;
      for (const { ts, min, p } of mins) {
        // ── ventana nocturna 00-04: solo FUERTE ──
        if (V.night && min < 240) {
          const v = vByMin.get(ts);
          if (v && v.a === 'COMPRAR_FUERTE' && v.c >= P.conf && ts - lastBuy >= CONFIG.SIGNAL_COOLDOWN_MS && nightSpent < P.nightCap * budget && remaining > 1) {
            const amt = Math.min(P.nightChunk * budget, P.nightCap * budget - nightSpent, remaining);
            mxn += amt; usdt += amt / p; remaining -= amt; nightSpent += amt; lastBuy = ts;
          }
        }
        // ── ventana matutina 07-12 ──
        if (min >= 420 && min < 720) {
          const v = vByMin.get(ts);
          if (v && v.c >= P.conf && ts - lastBuy >= CONFIG.SIGNAL_COOLDOWN_MS && remaining > 1) {
            const pct = v.a === 'COMPRAR_FUERTE' ? P.morFuerte : v.a === 'COMPRAR' ? P.morCompra : 0;
            if (pct > 0) { const amt = Math.min(pct * budget, remaining); mxn += amt; usdt += amt / p; remaining -= amt; lastBuy = ts; }
          }
          if (min % 30 === 0 && `${date}:${min}` !== lastSlot && remaining > 1) {
            lastSlot = `${date}:${min}`;
            const slotsLeft = Math.max(1, Math.ceil((720 - min) / 30));
            const bear = V.bearGuard && activeVerdict(ts)?.a === 'NO_COMPRAR';
            let pace;
            if (bear) pace = P.pace;                                  // bear: no acelerar, difiere
            else if (slotsLeft <= 1) pace = slotsLeft;                // último slot: todo
            else if (slotsLeft <= P.catchup) pace = 1;
            else pace = P.pace;
            const amt = slotsLeft <= 1 && !bear ? remaining : Math.min(remaining, remaining / slotsLeft * pace);
            if (amt > 0) { mxn += amt; usdt += amt / p; remaining -= amt; }
          }
        }
        // ── cola TWAP 12-24h para lo diferido por el bear guard ──
        if (min >= 720 && min % 30 === 0 && `${date}:${min}` !== lastSlot && remaining > 1) {
          lastSlot = `${date}:${min}`;
          const slotsLeft = Math.max(1, Math.ceil((1440 - min) / 30));
          const amt = slotsLeft <= 1 ? remaining : remaining / slotsLeft;
          mxn += amt; usdt += amt / p; remaining -= amt;
        }
      }
      if (remaining > 1 && mins.length) { const { p } = mins.at(-1); mxn += remaining; usdt += remaining / p; remaining = 0; }
      results[name].push({ date, cents: (twapAvg - mxn / usdt) * 100, usdt });
    }
  }

  // comparativa vs estrategias reales en LOS MISMOS días
  const REAL = ['aggressive_ai', 'momentum_opus', 'morning_ai', 'aggressive', 'bot'];
  const LBL = { aggressive_ai: 'Agresivo IA', momentum_opus: 'Momentum Opus', morning_ai: 'Mañana IA', aggressive: 'Agresivo', bot: 'Cauteloso' };
  console.log('\n=== ¢/día vs TWAP, mismos días ===');
  console.log('  día        ' + Object.keys(VARIANTS).map(k => k.slice(0, 9).padStart(10)).join('') + REAL.map(k => LBL[k].slice(0, 9).padStart(10)).join(''));
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const cells = Object.keys(VARIANTS).map(k => { const r = results[k][i]; return r ? ((r.cents >= 0 ? '+' : '') + r.cents.toFixed(2)).padStart(10) : '      —'; });
    const rcells = REAL.map(k => { const a = sByDate[date]?.[k], tw = sByDate[date]?.twap; return a && tw ? (((tw - a) * 100 >= 0 ? '+' : '') + ((tw - a) * 100).toFixed(2)).padStart(10) : '        —'; });
    console.log('  ' + date + cells.join('') + rcells.join(''));
  }
  console.log('\n=== RESUMEN (mismos ' + dates.length + ' días) ===');
  const summary = [];
  for (const [name, arr] of Object.entries(results)) {
    const cs = arr.map(x => x.cents); const m = cs.reduce((a, b) => a + b, 0) / cs.length;
    const util = arr.reduce((a, x) => a + x.cents / 100 * x.usdt, 0);
    summary.push({ name, m, win: cs.filter(c => c > 0).length / cs.length * 100, worst: Math.min(...cs), util });
  }
  for (const k of REAL) {
    const cs = [], us = [];
    for (const date of dates) { const a = sByDate[date]?.[k], tw = sByDate[date]?.twap; if (a && tw) { cs.push((tw - a) * 100); us.push(25_000_000 / a); } }
    if (!cs.length) continue;
    const m = cs.reduce((a, b) => a + b, 0) / cs.length;
    summary.push({ name: LBL[k], m, win: cs.filter(c => c > 0).length / cs.length * 100, worst: Math.min(...cs), util: cs.reduce((a, c, i) => a + c / 100 * us[i], 0) });
  }
  summary.sort((a, b) => b.m - a.m);
  console.log('  modelo               media¢/día  %días+   peor      util$');
  for (const s of summary) console.log('  ' + s.name.padEnd(20) + (s.m >= 0 ? '+' : '') + s.m.toFixed(2).padStart(6) + '   ' + String(Math.round(s.win)).padStart(4) + '%  ' + s.worst.toFixed(2).padStart(7) + '  ' + ((s.util >= 0 ? '+$' : '-$') + Math.abs(Math.round(s.util)).toLocaleString('es-MX')).padStart(11));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
