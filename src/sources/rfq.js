// Lector del precio RFQ de Bitso = NUESTRO precio institucional real de compra.
//
// ⚠️ SOLO LECTURA: usa exclusivamente "Request a Quote" (POST /rfq/v1/quotes), que
// según la doc de Bitso es puramente informativo y NO ejecuta ninguna operación.
// NUNCA llama a "Convert a Quote" ni a ningún endpoint que cierre/ejecute trades.
//
// Cotiza la compra de USDT pagando MXN (source=MXN, target=USDT) para obtener el
// precio real en MXN por USDT, comparable con el precio público de Bitso.
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';

const BASE = 'https://api.bitso.com';
const PATH = '/rfq/v1/quotes';

function authHeader(method, path, body) {
  const nonce = Date.now().toString();
  const data = nonce + method + path + body;
  const signature = crypto.createHmac('sha256', CONFIG.BITSO_API_SECRET).update(data).digest('hex');
  return `Bitso ${CONFIG.BITSO_API_KEY}:${nonce}:${signature}`;
}

// Devuelve el precio real (MXN por USDT) para una compra de referencia.
export async function fetchRfq() {
  if (!CONFIG.BITSO_API_KEY || !CONFIG.BITSO_API_SECRET) {
    throw new Error('Faltan BITSO_API_KEY / BITSO_API_SECRET');
  }
  const payload = JSON.stringify({
    source: 'mxn',
    target: 'usdt',
    source_amount: String(CONFIG.RFQ_QUOTE_MXN),
  });
  const res = await fetch(BASE + PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader('POST', PATH, payload),
    },
    body: payload,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`RFQ HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  const j = await res.json();
  const q = j.payload || j;                       // tolera envoltura
  const srcAmt = Number(q.source_amount);
  const tgtAmt = Number(q.target_amount);
  if (!srcAmt || !tgtAmt) throw new Error(`RFQ sin amounts: ${JSON.stringify(q).slice(0, 160)}`);
  // precio = MXN pagados / USDT recibidos = MXN por USDT (nuestro costo real)
  const price = srcAmt / tgtAmt;
  return { ts: Date.now(), price, rate: Number(q.rate) || null, id: q.id || null };
}
