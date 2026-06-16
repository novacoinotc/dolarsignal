// Lector del precio RFQ de Bitso = NUESTRO precio institucional real.
//
// ⚠️ SOLO LECTURA: usa exclusivamente "Request a Quote" (POST /rfq/v1/quotes), que
// según la doc de Bitso es puramente informativo y NO ejecuta ninguna operación.
// NUNCA llama a "Convert a Quote" ni a ningún endpoint que cierre/ejecute trades.
//
// Cotiza en ambos sentidos para conocer el precio real de COMPRA y de VENTA:
//   buy:  pagamos MXN, recibimos USDT  (lo que nos cuesta comprar)
//   sell: entregamos USDT, recibimos MXN (lo que nos pagan al vender)
// Ambos devuelven el precio en MXN por USDT, comparables entre sí.
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

async function requestQuote(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const res = await fetch(BASE + PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader('POST', PATH, payload) },
    body: payload,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`RFQ HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  const j = await res.json();
  return j.payload || j;
}

// Precio real de COMPRA (MXN por USDT que pagamos)
export async function fetchRfqBuy() {
  if (!CONFIG.BITSO_API_KEY) throw new Error('Faltan credenciales Bitso');
  const q = await requestQuote({ source: 'mxn', target: 'usdt', source_amount: String(CONFIG.RFQ_QUOTE_MXN) });
  const src = Number(q.source_amount), tgt = Number(q.target_amount);
  if (!src || !tgt) throw new Error(`RFQ buy sin amounts: ${JSON.stringify(q).slice(0, 120)}`);
  return { ts: Date.now(), price: src / tgt, id: q.id || null };   // MXN pagados / USDT recibidos
}

// Precio real de VENTA (MXN por USDT que nos pagan)
export async function fetchRfqSell() {
  if (!CONFIG.BITSO_API_KEY) throw new Error('Faltan credenciales Bitso');
  const q = await requestQuote({ source: 'usdt', target: 'mxn', source_amount: String(CONFIG.RFQ_QUOTE_USDT) });
  const src = Number(q.source_amount), tgt = Number(q.target_amount);
  if (!src || !tgt) throw new Error(`RFQ sell sin amounts: ${JSON.stringify(q).slice(0, 120)}`);
  return { ts: Date.now(), price: tgt / src, id: q.id || null };   // MXN recibidos / USDT entregados
}
