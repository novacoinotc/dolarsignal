import { performance, signalQuality } from '../src/queries.js';

export default async function handler(req, res) {
  try {
    const [days, quality] = await Promise.all([performance(), signalQuality()]);
    res.status(200).json({ days, quality });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
