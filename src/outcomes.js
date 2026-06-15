// Evaluador de resultados: para cada compra/señal, mide cuántos centavos se movió
// el precio después (15m, 60m, 240m). Así se valida si el bot compra en buenos momentos:
// delta POSITIVO = el precio subió después de comprar = compramos barato.

import { CONFIG } from './config.js';
import { q } from './db.js';
import { insertOutcome, priceNear } from './queries.js';

const PENDING_TRADES = `
  SELECT t.id, t.ts, t.price FROM trades t
  WHERE t.strategy = 'bot' AND t.reason = 'signal' AND t.ts <= $1
    AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.kind = 'trade' AND o.ref_id = t.id AND o.horizon_min = $2)
  LIMIT 50
`;

const PENDING_SIGNALS = `
  SELECT s.id, s.ts, s.price FROM signals s
  WHERE s.ts <= $1
    AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.kind = 'signal' AND o.ref_id = s.id AND o.horizon_min = $2)
  LIMIT 100
`;

export async function evaluateOutcomes(now = Date.now()) {
  for (const horizon of CONFIG.OUTCOME_HORIZONS) {
    const cutoff = now - horizon * 60_000;
    for (const [kind, query] of [['trade', PENDING_TRADES], ['signal', PENDING_SIGNALS]]) {
      for (const row of await q(query, [cutoff, horizon])) {
        const future = await priceNear('bitso', row.ts + horizon * 60_000);
        if (future === null) continue; // sin datos cerca de ese momento (gap), reintenta luego
        const delta = (future - row.price) * 100; // centavos
        await insertOutcome({ kind, refId: row.id, horizonMin: horizon, price: future, delta });
      }
    }
  }
}
