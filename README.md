# 💵 DolarSignal

Bot 24/7 de análisis y alertas de compra **USDT/MXN** para mesa OTC, con **paper trading** de $20,000,000 MXN diarios para medir cuántos centavos le gana al mercado antes de conectarlo a ejecución real.

## Arquitectura

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Railway        │ ──▶ │  Neon Postgres   │ ◀── │  Vercel          │
│  worker 24/7    │     │  (DATABASE_URL)  │     │  dashboard       │
│  src/index.js   │     │                  │     │  public/ + api/  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
  polea Bitso/Yahoo/      única fuente de          lee y grafica
  noticias, genera        verdad                   (solo lectura)
  señales y compra paper
```

- **Railway** corre el worker (proceso siempre activo): polling, señales, paper trading, alertas. También sirve el dashboard en su propio puerto (útil como healthcheck).
- **Neon** es la base de datos compartida.
- **Vercel** sirve el dashboard (`public/index.html` + funciones serverless en `api/`).

## Datos y análisis

**Fuentes en vivo (sin API keys):**
- **Bitso** — USDT/MXN (precio, bid/ask, volumen) cada 15 s. Es el instrumento que compras.
- **Yahoo Finance** — USD/MXN spot forex intradía cada 60 s (fallback: open.er-api.com). El driver macro.
- **Google News + Fed RSS** — noticias cada 5 min, calificadas por palabras clave que mueven USD/MXN (Banxico, FOMC, inflación, aranceles, nóminas…).
- **Calendario económico** — `data/calendar.json` (editable, requiere redeploy) con FOMC, Banxico, CPI, INEGI y NFP.

**Motor de señales** (corre en cada tick):

| Indicador | Qué detecta | Puntos |
|---|---|---|
| Z-score 60m | Precio estadísticamente barato vs su media | +1 / +2 |
| RSI 14 (1m) | Sobreventa (<30) / sobreventa extrema (<20) | +1 / +2 |
| Bollinger 20,2 | Precio tocando banda inferior | +1 |
| Caída rápida estabilizada | Spike a la baja ≥0.05% en 5m que encontró piso | +1 |
| Prima USDT comprimida | USDT barato relativo al dólar spot | +1 |

Score ≥ 1.5 → `WATCH` · ≥ 2.5 → `BUY` · ≥ 4 → `STRONG_BUY`.
En ventana de riesgo (45 min antes a 15 min después de un evento high-impact) las compras se **bloquean** y solo se alerta.

**Paper trading — bot vs TWAP:** las dos estrategias compran $20M MXN al día:
- `twap` (referencia): compra parejo cada 30 min — lo que haría la mesa sin bot.
- `bot`: compra oportunista en señales (`BUY` = $400k, `STRONG_BUY` = $1M, cooldown 5 min) y rellena el resto con slots para siempre completar el día.

**La métrica que importa:** diferencia de precio promedio ponderado bot vs TWAP = **centavos ganados por USDT** × volumen = ahorro diario en MXN. Además cada señal y compra se evalúa a +15m / +1h / +4h para validar si el precio realmente subió después.

## Deploy

### 1. Neon (base de datos)

Crea un proyecto en [neon.tech](https://neon.tech) (o vía Vercel Marketplace) y copia los dos connection strings: el directo y el **pooled** (host `-pooler`).

### 2. Railway (worker)

1. Nuevo proyecto → Deploy from GitHub repo (este repo). `railway.json` ya define el start command.
2. Variables: `DATABASE_URL` (string directo de Neon) y opcionalmente `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
3. El worker crea el schema automáticamente al arrancar.

### 3. Vercel (dashboard)

```bash
vercel link
echo "postgresql://...-pooler.../neondb?sslmode=require" | vercel env add DATABASE_URL production
vercel deploy --prod
```

Usa el connection string **pooled** de Neon en Vercel (las funciones serverless abren muchas conexiones).

### Desarrollo local

```bash
npm install
cp .env.example .env   # llena DATABASE_URL
npm start              # worker + dashboard en http://localhost:8420
```

## Proxys de salida

Si alguna fuente bloquea la IP del datacenter (el riesgo real es **Yahoo Finance** y a veces **Google News**; Bitso, la Fed y Telegram normalmente no), el worker soporta proxy sin cambios de código (Node ≥ 24):

```
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://usuario:password@host:puerto
NO_PROXY=api.bitso.com,api.telegram.org,*.neon.tech
```

Con `NO_PROXY` solo Yahoo/Google salen por el proxy; el resto va directo.

## Configuración

Todos los parámetros (presupuesto, umbrales de señales, cooldowns, tamaños de compra, ventanas de riesgo) están en `src/config.js` con comentarios. Las fechas de `data/calendar.json` son aproximadas — verifícalas contra los calendarios oficiales de la Fed y Banxico.

## Siguiente fase: ejecución real

Cuando el paper trading demuestre ahorro consistente, el punto de conexión es `src/trader.js` → función `execute()`: ahí se reemplaza el insert simulado por la llamada a la API de tu proveedor de ejecución (Bitso `POST /v3/orders`, o tu contraparte OTC). La lógica de señales, sizing y presupuesto queda igual.

## Limitaciones honestas

- El forex spot se mueve poco en fin de semana; el USDT/MXN de Bitso opera 24/7 — la prima es más ruidosa en fines de semana.
- Las señales son de reversión a la media (comprar dips). En tendencia alcista sostenida el ahorro viene de los dips intradía, no de predecir la tendencia.
- Paper trading asume ejecución al precio `last` de Bitso sin slippage. Con tu pricing institucional OTC el fill real puede diferir; calibra contra tus fills reales.
- El experimento solo es válido si el worker corre continuo (Railway lo garantiza con `restartPolicyType: ALWAYS`).
