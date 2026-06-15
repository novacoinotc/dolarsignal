// Monitor de noticias vía RSS (sin API keys): Google News MX + Fed + DOF-adjacent
// Scoring por palabras clave que históricamente mueven USD/MXN.

const FEEDS = [
  {
    name: 'GoogleNews-MX',
    url: 'https://news.google.com/rss/search?q=' +
      encodeURIComponent('peso mexicano OR banxico OR "tipo de cambio" OR "dólar hoy" OR superpeso') +
      '&hl=es-419&gl=MX&ceid=MX:es-419',
  },
  {
    name: 'GoogleNews-Macro',
    url: 'https://news.google.com/rss/search?q=' +
      encodeURIComponent('"federal reserve" OR FOMC OR "US inflation" OR tariffs Mexico OR "rate cut"') +
      '&hl=en-US&gl=US&ceid=US:en',
  },
  { name: 'Fed', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
];

// peso → impacto estimado en USD/MXN
const KEYWORDS = [
  ['banxico', 3], ['tasa de interés', 3], ['recorte de tasa', 3], ['sube la tasa', 3],
  ['fomc', 3], ['federal reserve', 2.5], ['fed ', 2], ['powell', 2],
  ['inflación', 2], ['inflation', 2], ['cpi', 2.5], ['inpc', 2.5],
  ['arancel', 3], ['tariff', 3], ['trump', 1.5], ['tlcan', 2], ['t-mec', 2], ['usmca', 2],
  ['nómina', 2], ['payrolls', 2.5], ['empleo', 1.5], ['desempleo', 1.5],
  ['pib', 2], ['gdp', 2], ['recesión', 2.5], ['recession', 2.5],
  ['remesas', 1.5], ['pemex', 1.5], ['calificación crediticia', 2.5], ['moody', 2], ['fitch', 2], ['s&p', 1.5],
  ['tipo de cambio', 2], ['peso mexicano', 1.5], ['superpeso', 1.5], ['depreciación', 2], ['devaluación', 3],
  ['intervención cambiaria', 3], ['comisión de cambios', 3],
];

function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const block of blocks) {
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim();
    const link = (block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1]?.trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]?.trim();
    if (title) {
      const parsed = pubDate ? Date.parse(pubDate) : NaN;
      items.push({ title, link, ts: Number.isNaN(parsed) ? Date.now() : parsed });
    }
  }
  return items;
}

export function scoreNews(title) {
  const lower = ` ${title.toLowerCase()} `;
  const hits = [];
  let score = 0;
  for (const [kw, weight] of KEYWORDS) {
    if (lower.includes(kw)) { hits.push(kw.trim()); score += weight; }
  }
  return { score, keywords: hits };
}

export async function fetchNews() {
  const all = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const item of parseRss(xml)) {
        const { score, keywords } = scoreNews(item.title);
        if (score > 0) all.push({ ...item, source: feed.name, score, keywords });
      }
    } catch { /* feed caído: seguimos con los demás */ }
  }
  return all;
}
