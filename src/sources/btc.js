// Precio de BTC como termómetro del riesgo cripto: cuando BTC sube fuerte suele
// bajar la demanda de USDT (rotación a BTC) y a la inversa.
//
// Fuente primaria: Bitso btc_mxn (mismo exchange que ya consultamos, no se bloquea
// desde datacenters). Para el z-score solo importa el movimiento relativo, así que
// BTC/MXN sirve igual que BTC/USD. Respaldos: Binance y Coinbase (BTC/USD).
const SOURCES = [
  { name: 'bitso', url: 'https://api.bitso.com/v3/ticker/?book=btc_mxn', pick: j => Number(j?.payload?.last) },
  { name: 'binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', pick: j => Number(j?.price) },
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', pick: j => Number(j?.data?.amount) },
];

export async function fetchBtc() {
  let lastErr;
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) { lastErr = new Error(`${s.name} HTTP ${res.status}`); continue; }
      const price = s.pick(await res.json());
      if (price) return { ts: Date.now(), price, source: s.name };
      lastErr = new Error(`${s.name} sin precio`);
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('BTC: todas las fuentes fallaron');
}
