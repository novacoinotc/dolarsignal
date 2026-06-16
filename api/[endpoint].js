// Función serverless única de Vercel para todos los endpoints de lectura.
// /api/state, /api/candles, /api/signals, /api/trades, /api/news, /api/performance
import { API } from '../src/server.js';

export default async function handler(req, res) {
  const endpoint = req.query.endpoint;
  const fn = API[endpoint];
  if (!fn) {
    res.status(404).json({ error: `endpoint desconocido: ${endpoint}` });
    return;
  }
  try {
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json(await fn(req.query));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
