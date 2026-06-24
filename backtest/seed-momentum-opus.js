// Siembra "Momentum Opus" desde el 16 jun corriendo Opus sobre el historial.
// Reconstruye el contexto cada 2h desde los datos guardados, le pide a Opus su
// veredicto de momentum, y simula las compras (a precio RFQ real) + slots para
// completar el presupuesto diario (= el de TWAP). Aproximado (el contexto se
// reconstruye), pero deja la estrategia empatada con las demás. Solo días COMPLETOS.
import { pool } from '../src/db.js';
import { CONFIG, tradingDate } from '../src/config.js';
import { ACCUMULATORS } from '../src/strategies.js';
import { zscore, rsi } from '../src/indicators.js';
import { activeBlackout, upcomingEvents } from '../src/calendar.js';
import { runMomentumAnalyst } from '../src/analyst.js';

const q = (s, p = []) => pool.query(s, p).then(r => r.rows);
const cfg = ACCUMULATORS.momentum_opus;
const TZ = CONFIG.TIMEZONE;
const SLOT = CONFIG.TWAP_SLOT_MINUTES, CATCHUP = 4, VERDICT_EVERY = 120; // min
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cdmxDate = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
const cdmxMin = ts => { const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ts)); return (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value); };

async function main() {
  await pool.query("DELETE FROM trades WHERE strategy='momentum_opus'");

  const load = src => q("SELECT (ts/60000)*60000 m,(array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source=$1 GROUP BY m ORDER BY m", [src]).then(r => r.map(x => ({ m: Number(x.m), p: Number(x.p) })));
  const rfq = await load('rfq'), bitso = await load('bitso'), btc = await load('btc'), spot = await load('spot');
  const news = (await q("SELECT ts, score, title FROM news WHERE score>=2.5 ORDER BY ts")).map(n => ({ ts: Number(n.ts), score: Number(n.score), title: n.title }));
  const sigs = (await q("SELECT ts, tier FROM signals ORDER BY ts")).map(s => ({ ts: Number(s.ts), tier: s.tier }));
  const twap = await q("SELECT date, SUM(mxn) mxn FROM trades WHERE strategy='twap' GROUP BY date");
  const budgetByDate = {}; for (const r of twap) budgetByDate[r.date] = Number(r.mxn);
  const rfqMap = new Map(rfq.map(r => [r.m, r.p]));
  const near = (arr, ts) => { for (let d = 0; d <= 5; d++) { const a = arr.find(x => x.m === ts - d*60000); if (a) return a.p; const b = arr.find(x => x.m === ts + d*60000); if (b) return b.p; } return null; };
  const priceNear = ts => { for (let d = 0; d <= 5; d++) { const a = rfqMap.get(ts - d*60000); if (a) return a; const b = rfqMap.get(ts + d*60000); if (b) return b; } return null; };
  const zOf = (arr, ts, win) => { const h = arr.filter(x => x.m <= ts && x.m > ts - (win+5)*60000).map(x => x.p); if (h.length < 10) return null; return zscore(h.slice(0, -1), h[h.length-1]); };
  const rsiOf = (ts) => { const h = bitso.filter(x => x.m <= ts && x.m > ts - 80*60000).map(x => x.p); return h.length > 15 ? rsi(h, CONFIG.RSI_PERIOD) : null; };

  const buildCtx = ts => {
    const b = near(bitso, ts), s = near(spot, ts);
    const last = sigs.filter(x => x.tier === 'STRONG_BUY' && x.ts <= ts).pop();
    const sig = {}; for (const x of sigs.filter(x => x.ts <= ts && x.ts > ts - 3600000)) sig[x.tier] = (sig[x.tier]||0)+1;
    const bo = activeBlackout(ts);
    return {
      now: ts, rfq: priceNear(ts), rfqSell: null, bitso: b, ask: b, spot: s,
      premium: b && s ? b/s - 1 : null, btc: near(btc, ts), btcZ: zOf(btc, ts, CONFIG.BTC_WINDOW_MIN),
      z: zOf(bitso, ts, CONFIG.ZSCORE_WINDOW_MIN), rsi: rsiOf(ts),
      sig, lastStrongMin: last ? Math.round((ts - last.ts)/60000) : null,
      blackout: bo ? bo.name : null,
      events: upcomingEvents(ts, 3).map(e => ({ name: e.name, inHours: Math.round((e.ts - ts)/3600000) })),
      leader: null,
      news: news.filter(n => n.ts <= ts && n.ts > ts - 3*3600000).sort((a,b)=>b.score-a.score).slice(0,8).map(n => ({ title: n.title.slice(0,90), score: n.score })),
    };
  };

  // 1) generar veredictos cada 2h (Opus)
  const today = cdmxDate(Date.now());
  const t0 = rfq[0].m, tEnd = Date.parse(today + 'T06:00:00Z'); // ~inicio de hoy CDMX en UTC (aprox)
  const verdicts = [];
  let calls = 0;
  for (let ts = t0; ts < tEnd; ts += VERDICT_EVERY*60000) {
    if (!priceNear(ts)) continue;
    const ctx = buildCtx(ts);
    let v;
    try { v = await runMomentumAnalyst(ctx); } catch (e) { v = { action: 'NO_COMPRAR', confidence: 0, reason: 'err' }; }
    verdicts.push({ ts, until: ts + VERDICT_EVERY*60000, ...v });
    calls++;
    if (calls % 10 === 0) console.log('  ...', calls, 'veredictos —', cdmxDate(ts), v.action);
    await sleep(250);
  }
  console.log('Veredictos Opus generados:', calls);
  const verdictAt = ts => verdicts.find(v => ts >= v.ts && ts < v.until) || null;

  // 2) simular por día
  const days = {}; for (const r of rfq) { const d = cdmxDate(r.m); (days[d] ??= []).push(r.m); }
  const rows = []; let lastMom = 0, lastSlotKey = null;
  for (const [date, mins] of Object.entries(days)) {
    if (date >= today) continue;
    const budget = budgetByDate[date]; if (!budget) continue;
    let remaining = budget;
    for (const ts of mins) {
      const minute = cdmxMin(ts), price = priceNear(ts); if (!price) continue;
      // compra momentum según veredicto activo
      const v = verdictAt(ts);
      if (v && remaining > 1 && ts - lastMom >= CONFIG.SIGNAL_COOLDOWN_MS && (v.confidence||0) >= 55) {
        let pct = v.action === 'COMPRAR_FUERTE' ? cfg.momFuertePct : v.action === 'COMPRAR' ? cfg.momPct : 0;
        if (pct > 0) { const amt = Math.min(budget*pct, remaining); rows.push([ts,date,'momentum_opus','momop',amt,price,amt/price]); remaining -= amt; lastMom = ts; }
      }
      // slot relleno
      if (minute % SLOT === 0) {
        const key = `${date}:${minute}`;
        if (key !== lastSlotKey && remaining > 1) {
          lastSlotKey = key;
          const slotsLeft = Math.max(1, Math.ceil((1440 - minute)/SLOT));
          const even = remaining/slotsLeft;
          let amt = slotsLeft <= 1 ? remaining : slotsLeft <= CATCHUP ? Math.min(remaining, even) : Math.min(remaining, even*cfg.slotPace);
          if (amt > 0) { rows.push([ts,date,'momentum_opus','slot',amt,price,amt/price]); remaining -= amt; }
        }
      }
    }
    if (remaining > 1 && mins.length) { const ts = mins[mins.length-1], p = priceNear(ts); if (p) rows.push([ts,date,'momentum_opus','slot',remaining,p,remaining/p]); }
  }

  for (let i = 0; i < rows.length; i += 500) {
    const c = rows.slice(i, i+500);
    const vals = c.map((_,j)=>`($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`).join(',');
    await pool.query(`INSERT INTO trades (ts,date,strategy,reason,mxn,price,usdt) VALUES ${vals}`, c.flat());
  }
  const chk = await q("SELECT date,COUNT(*) n,SUM(mxn) mxn,SUM(usdt) usdt FROM trades WHERE strategy='momentum_opus' GROUP BY date ORDER BY date");
  console.log('\\nSembrado Momentum Opus:');
  for (const r of chk) console.log('  '+r.date+': '+r.n+' ops · $'+Math.round(r.mxn).toLocaleString('es-MX')+' · avg '+(Number(r.mxn)/Number(r.usdt)).toFixed(4));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
