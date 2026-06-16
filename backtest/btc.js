// Descarga BTC/USD por hora de Coinbase (máx 300 velas por petición → en bloques).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'btc-1h.json');
const HDR = { 'User-Agent': 'Mozilla/5.0' };

export async function fetchBtcHourly(fromMs, toMs) {
  if (existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, 'utf8'));
    console.log(`BTC cache: ${c.length} barras`);
    return c;
  }
  console.log('Descargando BTC/USD por hora (12 meses) de Coinbase…');
  const STEP = 300 * 3600_000;   // 300 velas de 1h
  const out = new Map();
  for (let start = fromMs; start < toMs; start += STEP) {
    const end = Math.min(start + STEP, toMs);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600` +
      `&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    try {
      const res = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) { await sleep(400); continue; }
      const rows = await res.json();           // [time, low, high, open, close, volume]
      for (const r of rows) out.set(r[0] * 1000, r[4]);
    } catch { /* sigue */ }
    await sleep(350);                          // respeta rate limit
  }
  const bars = [...out.entries()].map(([ts, price]) => ({ ts, price })).sort((a, b) => a.ts - b.ts);
  writeFileSync(CACHE, JSON.stringify(bars));
  console.log(`BTC: ${bars.length} barras guardadas`);
  return bars;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
