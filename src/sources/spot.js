// USD/MXN spot intradía — Yahoo Finance (sin API key), con fallback a open.er-api.com
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/MXN=X?interval=1m&range=1h';
const FALLBACK = 'https://open.er-api.com/v6/latest/USD';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };

export async function fetchSpot() {
  try {
    const res = await fetch(YAHOO, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json = await res.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price) throw new Error('Yahoo sin precio');
    return { ts: Date.now(), price: Number(price), source: 'yahoo' };
  } catch (err) {
    // Fallback: tasa diaria (menos granular pero mantiene el sistema vivo)
    const res = await fetch(FALLBACK, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Fallback HTTP ${res.status} (Yahoo: ${err.message})`);
    const json = await res.json();
    const price = json?.rates?.MXN;
    if (!price) throw new Error('Fallback sin precio MXN');
    return { ts: Date.now(), price: Number(price), source: 'er-api' };
  }
}
