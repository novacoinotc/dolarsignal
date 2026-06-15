import { minuteCloses } from '../src/queries.js';

export default async function handler(req, res) {
  try {
    const hours = Math.min(Number(req.query.hours || 24), 168);
    const since = Date.now() - hours * 3600_000;
    const [bitso, spot] = await Promise.all([
      minuteCloses('bitso', since),
      minuteCloses('spot', since),
    ]);
    res.status(200).json({ bitso, spot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
