import { CONFIG, cdmxTime } from './config.js';

const TIER_EMOJI = { WATCH: '👀', BUY: '🟢', STRONG_BUY: '🔥', BLOCKED: '⛔' };

export async function sendAlert(title, body) {
  console.log(`\n🔔 [${cdmxTime()}] ${title}\n   ${body.split('\n').join('\n   ')}`);
  if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: `*${title}*\n${body}`,
          parse_mode: 'Markdown',
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error('[alerts] Telegram falló:', err.message);
    }
  }
}

export function alertSignal(signal) {
  const emoji = TIER_EMOJI[signal.tier] || '🔔';
  const title = `${emoji} Señal ${signal.tier} — USDT/MXN $${signal.price.toFixed(4)}`;
  const body = `Score: ${signal.score.toFixed(1)}\n${signal.reasons.map(r => `• ${r}`).join('\n')}`;
  return sendAlert(title, body);
}

export function alertNews(item) {
  return sendAlert(
    `📰 Noticia relevante (impacto ${item.score.toFixed(1)})`,
    `${item.title}\nClaves: ${item.keywords.join(', ')}\n${item.link || ''}`
  );
}
