// Precio de BTC/USD (Coinbase, sin API key). Sirve como termómetro del riesgo
// cripto: cuando BTC sube fuerte suele bajar la demanda de USDT (la gente sale
// de stablecoins a BTC) y a la inversa — un BTC cayendo puede presionar USDT.
const URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';

export async function fetchBtc() {
  const res = await fetch(URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
  const json = await res.json();
  const price = Number(json?.data?.amount);
  if (!price) throw new Error('Coinbase sin precio BTC');
  return { ts: Date.now(), price };
}
