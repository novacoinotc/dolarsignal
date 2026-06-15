import { recentBotTrades } from '../src/queries.js';

export default async function handler(req, res) {
  try {
    res.status(200).json(await recentBotTrades());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
