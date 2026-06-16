// Agente de IA en dos niveles:
//   - SCOUT (Haiku 4.5, "el chismoso"): revisa todo el contexto cada minuto y decide
//     si está pasando algo digno de escalar. Barato y rápido.
//   - ANALYST (Opus 4.8): cuando el scout escala (o hay STRONG_BUY / noticia fuerte),
//     hace el análisis profundo y da un veredicto razonado de compra en español.
//
// Ambos usan salida estructurada (output_config.format) para devolver JSON válido.
import Anthropic from '@anthropic-ai/sdk';
import { CONFIG, cdmxTime } from './config.js';

const client = CONFIG.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY }) : null;
export const aiEnabled = () => !!client;

// Convierte el contexto (objeto) a un texto compacto para el prompt
function describeContext(ctx) {
  const f = (n, d = 4) => n == null ? 's/d' : Number(n).toFixed(d);
  const lines = [
    `Hora CDMX: ${cdmxTime(ctx.now)}`,
    `USDT/MXN — nuestro precio real de COMPRA (RFQ): ${f(ctx.rfq)} · VENTA (RFQ): ${f(ctx.rfqSell)} · público Bitso: ${f(ctx.bitso)} (ask ${f(ctx.ask)})`,
    `USD/MXN spot: ${f(ctx.spot)} · prima USDT vs spot: ${ctx.premium == null ? 's/d' : (ctx.premium * 100).toFixed(3) + '%'}`,
    `BTC: ${ctx.btc == null ? 's/d' : Math.round(ctx.btc).toLocaleString('es-MX')} (z-score ${f(ctx.btcZ, 2)})`,
    `Indicadores USDT/MXN: z-score 60m ${f(ctx.z, 2)} · RSI ${f(ctx.rsi, 1)}`,
    `Señales última hora: STRONG_BUY ${ctx.sig.STRONG_BUY || 0}, BUY ${ctx.sig.BUY || 0}, WATCH ${ctx.sig.WATCH || 0}` +
      (ctx.lastStrongMin != null ? ` · último STRONG_BUY hace ${ctx.lastStrongMin} min` : ''),
    ctx.blackout ? `⚠ VENTANA DE RIESGO ACTIVA por evento: ${ctx.blackout}` : `Sin ventana de riesgo activa`,
    `Próximos eventos: ${(ctx.events || []).map(e => `${e.name} (${e.inHours}h)`).join(' · ') || 'ninguno cercano'}`,
    `Estrategia líder hoy: ${ctx.leader ? `${ctx.leader.label} (${ctx.leader.centavos >= 0 ? '+' : ''}${ctx.leader.centavos?.toFixed(2)}¢/USDT)` : 's/d'}`,
    `Noticias recientes (título · impacto keyword):`,
    ...(ctx.news || []).map(n => `  - [${n.score}] ${n.title}`),
  ];
  return lines.join('\n');
}

async function structured(model, system, user, schema, opts = {}) {
  const req = {
    model, max_tokens: opts.maxTokens || 1200,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  };
  if (opts.thinking) req.thinking = { type: 'adaptive' };
  const res = await client.messages.create(req);
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { data: JSON.parse(text), usage: res.usage };
}

const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    interesting: { type: 'boolean' },
    urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
    reason: { type: 'string' },
    factors: { type: 'array', items: { type: 'string' } },
  },
  required: ['interesting', 'urgency', 'reason', 'factors'],
};

const ANALYST_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    stance: { type: 'string', enum: ['COMPRAR_AHORA', 'COMPRAR_PARCIAL', 'ESPERAR', 'EVITAR'] },
    confidence: { type: 'integer' },
    headline: { type: 'string' },
    reasoning: { type: 'string' },
    marketRead: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    horizon: { type: 'string' },
  },
  required: ['stance', 'confidence', 'headline', 'reasoning', 'marketRead', 'risks', 'horizon'],
};

// SCOUT — barato, cada minuto. Devuelve si algo merece escalar a Opus.
export async function runScout(ctx) {
  const system = `Eres el "scout" de una mesa OTC que compra USDT/MXN ~$25M MXN al día. Tu trabajo es VIGILAR el mercado cada minuto y decidir si está pasando algo que merezca un análisis profundo del analista senior (Opus).
Marca interesting=true si ves: un dip notable (z-score bajo, RSI<35), señales STRONG_BUY recientes, una noticia de impacto real para el USD/MXN o cripto, una ventana de riesgo por evento próxima, o un movimiento brusco. Si todo está tranquilo y plano, interesting=false. Sé breve y concreto en español.`;
  const { data, usage } = await structured(CONFIG.SCOUT_MODEL, system, describeContext(ctx), SCOUT_SCHEMA, { maxTokens: 500 });
  return { ...data, usage };
}

// ANALYST — Opus, toma la decisión. Razona sobre todo el contexto.
export async function runAnalyst(ctx, scoutNote) {
  const system = `Eres el analista senior de una mesa OTC mexicana que compra USDT/MXN (~$25M MXN/día). Tu margen son centavos, así que cada centavo de mejor precio importa. Recibes el contexto de mercado y el reporte del scout. Da una recomendación de COMPRA accionable y razonada, en español claro y directo (sin tecnicismos innecesarios).

Considera: el precio real RFQ (lo que de verdad pagamos), los indicadores técnicos, la correlación con BTC, las NOTICIAS (interpreta su dirección real para el USD/MXN, no solo si mencionan la Fed: una Fed "dura"/hawkish suele FORTALECER el dólar = USDT sube; recortes de tasa lo debilitan), y el calendario (no conviene cargar fuerte justo antes de un evento de alto impacto).

stance: COMPRAR_AHORA (está barato y con buen momento), COMPRAR_PARCIAL (compra algo, guarda para mejor momento o por riesgo de evento), ESPERAR (probablemente bajará más o hay evento inminente), EVITAR (caro o riesgo alto). confidence 0-100. Sé honesto sobre la incertidumbre.`;
  const user = `${describeContext(ctx)}\n\n--- Reporte del scout ---\n${scoutNote || 'n/a'}`;
  const { data, usage } = await structured(CONFIG.ANALYST_MODEL, system, user, ANALYST_SCHEMA, { maxTokens: 1500, thinking: true });
  return { ...data, usage };
}
