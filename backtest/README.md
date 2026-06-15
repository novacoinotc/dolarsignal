# Backtest — 12 meses

`node backtest/backtest.js` (sin dependencias; cachea los datos en `usdmxn-1h.json`).

## Qué simula

La pregunta del negocio: **dado que de todas formas debemos comprar ~$20M MXN de USDT al día, ¿programar esas compras con señales le gana al TWAP tonto (comprar parejo)?**

Cada barra horaria evalúa los mismos indicadores del bot en vivo (z-score de la media móvil, RSI, Bollinger) → tier WATCH/BUY/STRONG_BUY. Luego se simula la compra diaria del presupuesto de forma **causal** (en cada barra solo se conoce la señal actual y el presupuesto restante — sin hindsight) y se compara el precio promedio pagado contra el TWAP. `avg_twap − avg_bot = centavos ganados por USDT`.

## Datos

- **USD/MXN spot por hora, 12 meses, de Yahoo Finance** (~6,200 barras).
- El instrumento real es USDT/MXN en Bitso, pero **Bitso no expone histórico OHLC público** y no hay fuente gratuita de USDT/MXN horario a 12 meses. Se usa USD/MXN como proxy: USDT/MXN = USD/MXN × (1 + prima ~0.03% estable). Como la métrica es una **diferencia** (bot − TWAP) sobre la misma serie, una prima multiplicativa constante **se cancela** — los centavos ahorrados son válidos.

## Resultados (periodo 2025-06-15 → 2026-06-15)

Edge vs TWAP, causal, $20M MXN/día (~$5.9 mil millones MXN/año comprados):

| Estrategia de asignación | Centavos/USDT | Ahorro MXN/año |
|---|---|---|
| Boost 2×/3× (lógica actual del bot: slot-fill + boost) | +0.013 | $44,447 |
| Boost 3×/6× | +0.024 | $83,388 |
| **Reserva 30% solo-señales** | +0.104 | $357,715 |
| **Reserva 50% solo-señales** | +0.176 | $604,181 |
| **Reserva 70% solo-señales** | +0.243 | $836,088 |

**Calidad de señales** (¿subió el precio después?): BUY a +1h acierta **54%** (+0.19¢ prom.); el edge se concentra en **+1 a +4h** y se desvanece o invierte a +24h (STRONG_BUY a +24h es **negativo**: −0.88¢, 42% acierto — un dip fuerte en USD/MXN tiende a seguir cayendo ese día, es régimen de momentum, no de reversión diaria).

## Conclusiones

1. **Programar las compras con señales le gana al TWAP** de forma consistente en agregado anual, aunque hay meses negativos.
2. **La lógica actual del bot (slot-fill) es conservadora** porque obliga a comprar en cada intervalo, diluyendo el edge. Una estrategia de **reserva** (guardar un "war-chest" y desplegarlo solo en señales) captura 10-20× más — a costa de **riesgo de inventario intradía** (estás sub-comprado hasta que llegan las señales, relevante para una mesa que debe entregar USDT a clientes).
3. **El edge es intradía (1-4h).** El bot en vivo opera a **nivel minuto** y puede capturar dips que este backtest horario literalmente no ve, por lo que estos números son un **piso conservador**.

## Limitaciones honestas

- Granularidad horaria, no minuto (el backtest no ve dips intra-hora).
- Proxy USD/MXN spot por USDT/MXN (la prima se cancela en la métrica de diferencia).
- **Sin costos/slippage**, pero se comparan bot vs TWAP sobre la misma serie y mismo volumen → los costos de transacción se cancelan en gran medida; lo que importa es el diferencial de precio.
- Sin ventanas de blackout por eventos (no hay fechas históricas de eventos en el dataset).
- La estrategia de reserva asume que el sobrante no desplegado se compra al cierre del día (modelado causalmente); en la práctica el riesgo de inventario debe gestionarse.
