// Indicadores técnicos sobre series de cierres por minuto

export function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function zscore(xs, value) {
  const sd = stdev(xs);
  if (!sd) return 0;
  return (value - mean(xs)) / sd;
}

export function ema(xs, period) {
  if (!xs.length) return null;
  const k = 2 / (period + 1);
  let e = xs[0];
  for (let i = 1; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (gains + losses === 0) return 50;
  const rs = losses === 0 ? Infinity : gains / losses;
  return 100 - 100 / (1 + rs);
}

export function bollinger(closes, period = 20, k = 2) {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const m = mean(window);
  const sd = stdev(window);
  return { mid: m, upper: m + k * sd, lower: m - k * sd };
}
