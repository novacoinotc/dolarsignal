// Siembra el histórico de la estrategia "Momentum IA" desde que arrancaron las demás
// (replay determinista sobre los datos REALES ya guardados: precio RFQ para ejecutar,
// bitso para z-score, btc para risk-off, news para catalizador). Mismo presupuesto
// diario que el resto (= lo que gastó TWAP cada día) y misma lógica de slots, para que
// quede empatada y comparable. Solo siembra días COMPLETOS; el día de hoy lo maneja el
// worker en vivo.
import { pool } from '../src/db.js';
import { CONFIG, tradingDate } from '../src/config.js';
import { ACCUMULATORS } from '../src/strategies.js';
import { zscore } from '../src/indicators.js';

const q = (s, p = []) => pool.query(s, p).then(r => r.rows);
const cfg = ACCUMULATORS.momentum;
const TZ = CONFIG.TIMEZONE;
const SLOT = CONFIG.TWAP_SLOT_MINUTES;      // 30
const CATCHUP = 4;

const cdmxDate = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
const cdmxMin = ts => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ts));
  return (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value);
};

async function main() {
  // 1) borrar siembra previa (idempotente)
  await pool.query("DELETE FROM trades WHERE strategy='momentum'");

  // 2) cargar series por minuto
  const rfq = await q("SELECT (ts/60000)*60000 m, (array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='rfq' GROUP BY m ORDER BY m");
  const bitso = await q("SELECT (ts/60000)*60000 m, (array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='bitso' GROUP BY m ORDER BY m");
  const btc = await q("SELECT (ts/60000)*60000 m, (array_agg(price ORDER BY ts DESC))[1] p FROM ticks WHERE source='btc' GROUP BY m ORDER BY m");
  const news = await q("SELECT ts, score FROM news WHERE score >= $1 ORDER BY ts", [cfg.momNews]);
  const twap = await q("SELECT date, SUM(mxn) mxn FROM trades WHERE strategy='twap' GROUP BY date");

  const rfqAt = new Map(rfq.map(r => [Number(r.m), Number(r.p)]));
  const bitsoArr = bitso.map(r => ({ m: Number(r.m), p: Number(r.p) }));
  const btcArr = btc.map(r => ({ m: Number(r.m), p: Number(r.p) }));
  const newsTs = news.map(n => Number(n.ts));
  const budgetByDate = {}; for (const r of twap) budgetByDate[r.date] = Number(r.mxn);

  const today = cdmxDate(Date.now());
  // precio rfq más cercano (±5 min) a un timestamp
  const priceNear = ts => {
    for (let d = 0; d <= 5; d++) {
      const a = rfqAt.get(ts - d * 60000); if (a) return a;
      const b = rfqAt.get(ts + d * 60000); if (b) return b;
    }
    return null;
  };
  const zAt = (arr, ts, win) => {
    const hist = arr.filter(x => x.m <= ts && x.m > ts - (win + 5) * 60000).map(x => x.p);
    if (hist.length < 10) return null;
    return zscore(hist.slice(0, -1), hist[hist.length - 1]);
  };
  const newsCatalystAt = ts => newsTs.some(n => n <= ts && n > ts - 30 * 60000);

  // 3) agrupar minutos rfq por día
  const days = {};
  for (const r of rfq) { const d = cdmxDate(Number(r.m)); (days[d] ??= []).push(Number(r.m)); }

  const rows = [];
  let lastMomBuy = 0, lastSlotKey = null;
  for (const [date, mins] of Object.entries(days)) {
    if (date >= today) continue;             // hoy lo maneja el worker en vivo
    const budget = budgetByDate[date]; if (!budget) continue;
    let remaining = budget;
    const endMin = 1440;
    for (const ts of mins) {
      const minute = cdmxMin(ts);
      const price = priceNear(ts); if (!price) continue;
      const z = zAt(bitsoArr, ts, CONFIG.ZSCORE_WINDOW_MIN);
      const btcZ = zAt(btcArr, ts, CONFIG.BTC_WINDOW_MIN);

      // (a) compra momentum (catalizador) — misma lógica que onMomentum
      if (z != null && remaining > 1 && ts - lastMomBuy >= CONFIG.SIGNAL_COOLDOWN_MS) {
        let pct = 0;
        if (z >= cfg.momZStrong || newsCatalystAt(ts) || (btcZ != null && btcZ <= cfg.momBtcZ)) pct = cfg.momStrongPct;
        else if (z >= cfg.momZBuy) pct = cfg.momBuyPct;
        if (pct > 0) {
          const amount = Math.min(budget * pct, remaining);
          rows.push([ts, date, 'momentum', 'mom', amount, price, amount / price]);
          remaining -= amount; lastMomBuy = ts;
        }
      }
      // (b) slot de relleno cada 30 min — misma lógica que onSlotCheck
      if (minute % SLOT === 0) {
        const key = `${date}:${minute}`;
        if (key !== lastSlotKey && remaining > 1 && minute <= endMin) {
          lastSlotKey = key;
          const slotsLeft = Math.max(1, Math.ceil((endMin - minute) / SLOT));
          const evenPace = remaining / slotsLeft;
          let amount;
          if (slotsLeft <= 1) amount = remaining;
          else if (slotsLeft <= CATCHUP) amount = Math.min(remaining, evenPace);
          else amount = Math.min(remaining, evenPace * cfg.slotPace);
          if (amount > 0) { rows.push([ts, date, 'momentum', 'slot', amount, price, amount / price]); remaining -= amount; }
        }
      }
    }
    // si quedó remanente (poca data al final del día), gástalo al último precio
    if (remaining > 1 && mins.length) {
      const ts = mins[mins.length - 1], price = priceNear(ts);
      if (price) rows.push([ts, date, 'momentum', 'slot', remaining, price, remaining / price]);
    }
  }

  // 4) insertar en lotes
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const vals = chunk.map((_, j) => `($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`).join(',');
    await pool.query(`INSERT INTO trades (ts,date,strategy,reason,mxn,price,usdt) VALUES ${vals}`, chunk.flat());
  }

  // 5) verificar
  const chk = await q("SELECT date, COUNT(*) n, SUM(mxn) mxn, SUM(usdt) usdt FROM trades WHERE strategy='momentum' GROUP BY date ORDER BY date");
  console.log('Sembrado Momentum:');
  for (const r of chk) console.log('  ' + r.date + ': ' + r.n + ' ops · $' + Math.round(r.mxn).toLocaleString('es-MX') + ' · avg ' + (Number(r.mxn)/Number(r.usdt)).toFixed(4));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
