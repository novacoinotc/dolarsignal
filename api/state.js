import { buildState } from '../src/server.js';

export default async function handler(req, res) {
  try {
    res.status(200).json(await buildState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
