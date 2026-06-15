// Bitso API pública — ticker USDT/MXN (sin API key)
const URL = 'https://api.bitso.com/v3/ticker/?book=usdt_mxn';

export async function fetchBitso() {
  const res = await fetch(URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Bitso HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error('Bitso respondió success=false');
  const p = json.payload;
  return {
    ts: Date.now(),
    price: Number(p.last),
    bid: Number(p.bid),
    ask: Number(p.ask),
    volume: Number(p.volume),
  };
}
