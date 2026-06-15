// Dashboard web del worker (desarrollo local y Railway) — mismo API que las funciones de Vercel
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import {
  lastTick, minuteCloses, recentSignals, recentBotTrades, recentNews,
  performance, signalQuality, todayStats,
} from './queries.js';
import { indicatorSnapshot } from './signals.js';
import { upcomingEvents, activeBlackout } from './calendar.js';

const HTML_PATH = path.join(CONFIG.ROOT, 'public', 'index.html');

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export async function buildState() {
  const [bitso, spot, indicators, today] = await Promise.all([
    lastTick('bitso'), lastTick('spot'), indicatorSnapshot(), todayStats(),
  ]);
  const blackout = activeBlackout();
  return {
    now: Date.now(),
    bitso, spot,
    premium: bitso && spot ? bitso.price / spot.price - 1 : null,
    indicators, today,
    blackout: blackout ? blackout.name : null,
    events: upcomingEvents(),
  };
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      switch (url.pathname) {
        case '/': {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(readFileSync(HTML_PATH));
        }
        case '/api/state':
          return json(res, await buildState());
        case '/api/candles': {
          const hours = Math.min(Number(url.searchParams.get('hours') || 24), 168);
          const since = Date.now() - hours * 3600_000;
          const [bitso, spot] = await Promise.all([minuteCloses('bitso', since), minuteCloses('spot', since)]);
          return json(res, { bitso, spot });
        }
        case '/api/signals':
          return json(res, await recentSignals());
        case '/api/trades':
          return json(res, await recentBotTrades());
        case '/api/news':
          return json(res, await recentNews());
        case '/api/performance':
          return json(res, { days: await performance(), quality: await signalQuality() });
        default: {
          res.writeHead(404);
          return res.end('Not found');
        }
      }
    } catch (err) {
      console.error('[server]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  server.listen(CONFIG.PORT, () => {
    console.log(`📊 Dashboard: http://localhost:${CONFIG.PORT}`);
  });
  return server;
}
