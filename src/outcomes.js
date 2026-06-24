// Evaluador de resultados: para cada compra/señal, mide cuántos centavos se movió
// el precio después (15m, 60m, 240m). delta POSITIVO = el precio subió después de
// comprar = compramos barato.
//
// Las compras se evalúan contra el precio RFQ futuro (el real al que nos venden);
// las señales contra el precio público de Bitso (es detección de mercado). Si no
// hay RFQ disponible, las compras caen al precio público.

import { CONFIG } from './config.js';
import { q } from './db.js';
import { insertOutcome, priceNear } from './queries.js';

// Compras oportunistas de cualquier estrategia (señal/compra del trader)
const PENDING_TRADES = `
  SELECT t.id, t.ts, t.price FROM trades t
  WHERE t.reason IN ('signal', 'buy', 'ai', 'mom', 'momop') AND t.ts <= $1
    AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.kind = 'trade' AND o.ref_id = t.id AND o.horizon_min = $2)
  ORDER BY t.ts DESC LIMIT 80
`;

const PENDING_SIGNALS = `
  SELECT s.id, s.ts, s.price FROM signals s
  WHERE s.ts <= $1
    AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.kind = 'signal' AND o.ref_id = s.id AND o.horizon_min = $2)
  ORDER BY s.ts DESC LIMIT 100
`;

export async function evaluateOutcomes(now = Date.now()) {
  for (const horizon of CONFIG.OUTCOME_HORIZONS) {
    const cutoff = now - horizon * 60_000;
    for (const [kind, query, source] of [['trade', PENDING_TRADES, 'rfq'], ['signal', PENDING_SIGNALS, 'bitso']]) {
      for (const row of await q(query, [cutoff, horizon])) {
        const at = row.ts + horizon * 60_000;
        const future = await priceNear(source, at) ?? await priceNear('bitso', at);
        if (future === null) continue; // sin datos cerca de ese momento (gap), reintenta luego
        const delta = (future - row.price) * 100; // centavos
        await insertOutcome({ kind, refId: row.id, horizonMin: horizon, price: future, delta });
      }
    }
  }
}
