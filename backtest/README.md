# Backtest — 12 meses, 7 estrategias

`node backtest/backtest.js` (sin dependencias; cachea datos en `usdmxn-1h.json` y `btc-1h.json`).

## Qué simula

La pregunta del negocio: **dado que de todos modos compramos ~$20M MXN de USDT al día, ¿qué forma de programar esas compras consigue el mejor precio?** Simula hora por hora, de forma **causal** (sin ver el futuro), las 7 estrategias del laboratorio en vivo y las compara contra la compra pareja (TWAP).

## Datos

- **USD/MXN spot por hora, 12 meses (Yahoo)** como proxy del USDT/MXN. Como las métricas son **diferencias** entre estrategias sobre la misma serie, la prima USDT (~0.03%, constante) se cancela.
- **BTC/USD por hora, 12 meses (Coinbase)** para la señal de correlación cripto (BTC en alza fuerte → USDT relativamente barato).

## Resultados (2025-06-15 → 2026-06-15, causal)

| Estrategia | Centavos/USDT vs pareja | Ahorro 12 meses |
|---|---|---|
| 🔴 **Agresivo** | **+0.205¢** | **$705,442** |
| 🧠 Inteligente | +0.102¢ | $352,090 |
| 🟣 Sesiones | +0.062¢ | $212,762 |
| 🟢 Cauteloso | +0.010¢ | $34,185 |
| 🟰 Pareja (TWAP) | — (referencia) | $0 |
| 🟡 Viernes | −0.013¢ | −$45,170 (ver nota) |

**Trader** (compra barato / toma ganancia): **+$141,269 MXN realizados** en 12 meses (54 compras / 51 ventas).

**Calidad de señales:** STRONG_BUY a +4h da +0.41¢ con 53% de acierto (el mejor horizonte); a +24h se invierte (−0.97¢, 40%) → el dólar en caída fuerte tiende a seguir cayendo ese día (momentum, no reversión diaria). El edge vive en **1–4h**.

## Conclusiones

1. **El agresivo gana claramente** (+0.20¢, ~$705k/año): guardar reserva y soltarla fuerte en los dips es lo que más captura. A cambio: **riesgo de inventario intradía** (anda corto de USDT mientras espera señales).
2. **El inteligente (todo junto) queda 2º** — combinar sesiones + viernes con el núcleo agresivo es más conservador que el agresivo puro, pero más robusto.
3. **Las sesiones aportan** (+0.06¢): comprar más en las horas líquidas (europea/americana) ayuda.
4. **El trader es viable** con toma de ganancia: +$141k/año de pura especulación, además del ahorro en compras.

## Limitaciones honestas

- **Granularidad horaria, no minuto.** El bot en vivo opera a nivel minuto y captura dips intra-hora que aquí no se ven → **estos números son un piso conservador**.
- **El "efecto viernes" NO se puede backtestear con datos de forex** (el dólar no cotiza fin de semana, así que no existe el "precio caro de fin de semana" en los datos). En el backtest, "Viernes" solo prueba el *timing* (concentrar la compra el viernes antes de las 2:30pm), que por sí solo es ~neutral. **El valor real del viernes — la prima de baja liquidez del fin de semana en Bitso — solo se mide EN VIVO**, y por eso el dashboard tiene el monitor "Efecto viernes".
- Proxy USD/MXN por USDT/MXN (prima constante se cancela en la métrica de diferencia).
- Sin costos/slippage: se comparan estrategias sobre la misma serie, así que los costos se cancelan en gran medida.
- El periodo fue de tendencia alcista del USD/MXN (~17.4 → ~18.0); los resultados pueden variar en regímenes distintos.
