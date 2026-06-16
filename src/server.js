// Dashboard web del worker (desarrollo local y Railway) — mismo API que las funciones de Vercel
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import {
  lastTick, minuteCloses, recentSignals, recentTrades, recentNews,
  performance, dailyPerformance, signalQuality, todayStats, traderPnl, fridayEffect,
} from './queries.js';
import { indicatorSnapshot } from './signals.js';
import { upcomingEvents, activeBlackout } from './calendar.js';

const HTML_PATH = path.join(CONFIG.ROOT, 'public', 'index.html');

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export async function buildState() {
  const [bitso, spot, btc, indicators, today] = await Promise.all([
    lastTick('bitso'), lastTick('spot'), lastTick('btc'), indicatorSnapshot(), todayStats(),
  ]);
  const blackout = activeBlackout();
  return {
    now: Date.now(),
    bitso, spot, btc,
    premium: bitso && spot ? bitso.price / spot.price - 1 : null,
    indicators, today,
    blackout: blackout ? blackout.name : null,
    events: upcomingEvents(),
  };
}

// Mapa de rutas → handler, reutilizado por el server local y las funciones Vercel
export const API = {
  state: () => buildState(),
  candles: async (params) => {
    const hours = Math.min(Number(params.hours || 24), 168);
    const since = Date.now() - hours * 3600_000;
    const [bitso, spot, btc] = await Promise.all([
      minuteCloses('bitso', since), minuteCloses('spot', since), minuteCloses('btc', since),
    ]);
    return { bitso, spot, btc };
  },
  signals: () => recentSignals(),
  trades: () => recentTrades(),
  news: () => recentNews(),
  performance: async () => ({
    global: await performance(),
    days: await dailyPerformance(),
    quality: await signalQuality(),
    trader: await traderPnl(),
    friday: await fridayEffect(),
  }),
};

export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(HTML_PATH));
      }
      const m = url.pathname.match(/^\/api\/(\w+)$/);
      if (m && API[m[1]]) {
        return json(res, await API[m[1]](Object.fromEntries(url.searchParams)));
      }
      res.writeHead(404);
      res.end('Not found');
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
