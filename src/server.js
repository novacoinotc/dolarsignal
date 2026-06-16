// Dashboard web del worker (desarrollo local y Railway) — mismo API que las funciones de Vercel
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import {
  lastTick, minuteCloses, ohlc, recentSignals, recentTrades, recentNews,
  performance, dailyPerformance, signalQuality, todayStats, traderPnl, fridayEffect, rfqByHour,
  latestAnalysis, recentAnalyses,
} from './queries.js';
import { indicatorSnapshot } from './signals.js';
import { upcomingEvents, activeBlackout } from './calendar.js';

const HTML_PATH = path.join(CONFIG.ROOT, 'public', 'index.html');

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export async function buildState() {
  const [bitso, spot, btc, rfq, rfqSell, indicators, today, analyst, scout] = await Promise.all([
    lastTick('bitso'), lastTick('spot'), lastTick('btc'), lastTick('rfq'), lastTick('rfq_sell'),
    indicatorSnapshot(), todayStats(), latestAnalysis('analyst'), latestAnalysis('scout'),
  ]);
  const blackout = activeBlackout();
  return {
    now: Date.now(),
    bitso, spot, btc, rfq, rfqSell,
    premium: bitso && spot ? bitso.price / spot.price - 1 : null,
    // RFQ vs precio público de COMPRA (ask): positivo = nuestro RFQ es más barato que el libro
    rfqEdge: rfq && bitso ? ((bitso.ask || bitso.price) - rfq.price) * 100 : null,
    indicators, today,
    blackout: blackout ? blackout.name : null,
    events: upcomingEvents(),
    analyst: analyst ? { ts: Number(analyst.ts), ...analyst.payload } : null,
    scout: scout ? { ts: Number(scout.ts), ...scout.payload } : null,
  };
}

// Mapa de rutas → handler, reutilizado por el server local y las funciones Vercel
export const API = {
  state: () => buildState(),
  candles: async (params) => {
    const hours = Math.min(Number(params.hours || 24), 168);
    const since = Date.now() - hours * 3600_000;
    const [bitso, spot, btc, rfq] = await Promise.all([
      minuteCloses('bitso', since), minuteCloses('spot', since),
      minuteCloses('btc', since), minuteCloses('rfq', since),
    ]);
    return { bitso, spot, btc, rfq };
  },
  ohlc: async (params) => {
    const hours = Math.min(Number(params.hours || 24), 720);
    const interval = Math.min(Math.max(Number(params.interval || 15), 1), 240);
    const since = Date.now() - hours * 3600_000;
    const source = ['bitso', 'rfq', 'spot'].includes(params.source) ? params.source : 'bitso';
    // velas del instrumento + líneas de referencia (RFQ compra y spot) por minuto
    const [candles, rfqLine, spotLine] = await Promise.all([
      ohlc(source, interval, since),
      minuteCloses('rfq', since),
      minuteCloses('spot', since),
    ]);
    return { candles, rfqLine, spotLine, interval, source };
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
    rfqByHour: await rfqByHour(),
  }),
  analysis: async () => {
    const rows = await recentAnalyses('analyst', 15);
    return rows.map(r => ({ ts: Number(r.ts), model: r.model, ...r.payload }));
  },
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
