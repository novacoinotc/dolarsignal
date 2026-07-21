// Función serverless única de Vercel para todos los endpoints de lectura,
// más el único endpoint de ESCRITURA: POST /api/sale (reportar venta de USDT
// del stock real; protegido con PIN en env SALE_PIN).
import { API } from '../src/server.js';
import { insertRealSale } from '../src/queries.js';

export default async function handler(req, res) {
  const endpoint = req.query.endpoint;

  if (endpoint === 'sale') {
    if (req.method !== 'POST') { res.status(405).json({ error: 'usa POST' }); return; }
    const { usdt, price, note, pin } = req.body || {};
    if (!process.env.SALE_PIN || pin !== process.env.SALE_PIN) {
      res.status(401).json({ error: 'PIN incorrecto' });
      return;
    }
    const amount = Number(usdt);
    if (!amount || amount <= 0 || amount > 10_000_000) { res.status(400).json({ error: 'monto inválido' }); return; }
    await insertRealSale({ ts: Date.now(), usdt: amount, price: price ? Number(price) : null, note });
    res.status(200).json({ ok: true, usdt: amount });
    return;
  }

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
