# ¿Existe un "TimesFM para precios"? — Investigación consolidada (17-sep-2026)

Cinco investigaciones independientes en paralelo (modelos fundacionales, evidencia académica y competencias,
práctica de mesas y proveedores, LLMs/IA para trading, y código abierto en GitHub/HF/Kaggle), cada una
verificando contra fuentes originales. Pregunta: ¿hay algún modelo que prediga precios de mercado a corto
plazo (minutos-días) mejor que "mañana = hoy", con evidencia fuera de muestra y después de costos?

## Veredicto: NO — y las cinco fuentes convergen en el mismo mapa

| Evidencia | Qué dice |
|---|---|
| Techo teórico (arXiv 2606.27100) | Información del pasado sobre el retorno de mañana ≈ 0.005 nats → R² máximo ≈ 1% |
| Mayor estudio de modelos fundacionales en finanzas (2B obs, 94 países, 50k GPU-h; arXiv 2511.18578) | Zero-shot "por debajo de CatBoost/LightGBM"; el fine-tuning no cierra la brecha; ni pre-entrenar desde cero da R² positivo |
| FX (Meese-Rogoff 1983 → Rossi 2013 → Cheung 2019 → Fed 2025) | "Ningún modelo supera consistentemente al paseo aleatorio"; intradía: predictibilidad estadística que muere con costos |
| Modelos "financieros" (Kronos, FinCast, EXAONE Finance) | NO comparan contra el ingenuo; réplicas independientes de Kronos: dirección diaria 49.5% (peor que "siempre sube" 54.6%); issues #354/#375/#355 sin respuesta |
| Competencias con dinero real (Numerai, Jane Street 3,700 equipos, DRW, G-Research) | Correlación 0.01-0.13 con retornos = 51-52.5% de acierto; se monetiza solo con miles de apuestas simultáneas; ningún ganador usó un modelo fundacional — todos LightGBM/CatBoost + features |
| LLMs operando dinero real (Alpha Arena, 8 modelos frontier) | Todos perdieron en acciones (−33%); "darle dinero a un LLM no funciona todavía" |
| Agentes multi-LLM (TradingAgents 107k★) | Look-ahead en los pesos; en 20 años/100+ símbolos "las ventajas se deterioran significativamente" |
| Cripto reversión 15-min (arXiv 2608.21888, 183 pares) | Real en el 90% de pares... vale 1.3 pb contra 5 pb de costo |
| Nuestra prueba propia (TimesFM 2.5/3.0, 13 series) | Ratio de error 0.98-1.07 vs ingenuo en FX/cripto/acciones/oro; dirección 42-59% |

## Lo que SÍ es predecible (con evidencia sólida) — y es donde está el dinero de una mesa

| Objetivo | Evidencia | Magnitud |
|---|---|---|
| **Volatilidad** (cuánto se mueve, no hacia dónde) | HAR-RV (Corsi) casi imbatible; Optiver: ML gana ~15-20% sobre naive | Sirve para dimensionar tramos y tolerancias |
| **Estacionalidad intradía de spread/volumen/vol** | Talos (250k órdenes): R² 80% spreads, 65-75% volumen; ahorros **7-38 pb** vs ejecución ingenua | 1 pb en $25M/día ≈ $600-650k MXN/año |
| **USD/MXN por hora y evento** (Banxico WP 2021-05, 10 años a 5 min) | Vol: apertura Londres +41%, NY +17%; FOMC **+337%**, NFP +311%, Banxico +145%; **se disipa en <1 h**; CPI/PIB México NO significativos; jueves > lunes | Bloquear RFQ ±60 min FOMC/NFP, ±30 Banxico: gratis |
| **Fin de semana / horas muertas** (Kaiko, Amberdata) | Spread ×2 en finde; profundidad −42% a las 21:00 UTC | Coincide con nuestro +0.6¢ de finde |
| **Prima USDT/MXN** (BIS WP 1340 / FMI 2026; Corea) | Media 0.37-0.48%, máx 3%; shocks de flujo persisten ~10 días; en Corea revierte con vida media ~24 min; el sentimiento de noticias NO añade | Es un spread con reversión a la media: modelable con OU + boosting |
| **Competencia entre proveedores de liquidez** (Borderless, MXN) | Hasta **32 pb** de diferencia entre proveedores; $2,330 perdidos por millón por no enrutar | Segunda cotización (Circle StableFX, otros LPs) |

## Crítica que nos toca (la aceptamos)

"La rotación de campeones observada en forward es el síntoma clásico de sobreajuste por selección; con un solo
par y ~250 días al año no hay potencia estadística para distinguir regímenes ex-ante" (frente académico). Lo que
ha generado valor en DolarSignal no fue predicción: fue **comportamiento de ejecución** (comprar caídas, no
cargarse en rallies, no comprar el finde caro, completar el día). El sistema debe re-centrarse ahí.

## Hoja de ruta recomendada (por evidencia y esfuerzo)

1. **Capa de medición primero (TCA propio):** cada compra real en pb contra 3 benchmarks — precio de llegada,
   FIX del día, VWAP Bitso 9-15h — con walk-forward y costos por hora. Sin esto no se puede distinguir nada.
2. **"Execution-alpha stack" (estilo Talos):** perfil minuto-del-día de prima RFQ, spread, volumen y vol,
   recalibrado cada noche → schedule VWAP-adaptativo del día + umbral de aceptación de cotización por hora.
   Reglas que salen gratis: concentrar 8:30-12:00 CDMX (solape Londres/NY + FIX), vaciar antes del cierre NY,
   bloquear eventos. Herramientas: `statsforecast` (MSTL) + `arch` (HARX).
3. **Prima USDT/MXN como proceso Ornstein-Uhlenbeck** (mid Bitso − spot interbancario, por minuto) y usarla para
   inclinar el ritmo de compra (marco Cartea-Jaimungal / Lehalle-Neuman, solución cerrada); HAR-RV horario decide
   el tamaño del tramo. El "crash-dip" manual es, formalmente, "prima muy negativa + vol alta".
4. **Poner la RFQ en competencia** (Circle StableFX con Bitso como emisor MXN, otros LPs): hasta 32 pb.
5. **Re-orientar a Opus:** de "¿compro?" a "¿qué tan riesgosa es la próxima hora?" (probabilidad de movimiento
   >X pb, régimen de noticias, etiquetado de eventos). Medido solo como reducción de costo vs pacer, prospectivo.
6. **Experimentos opcionales, expectativa baja y protocolo estricto (Diebold-Mariano vs ingenuo, post-cutoff):**
   TTM (IBM, Apache, 1-5M params) para volatilidad/spread; Kronos-base (MIT) como *feature* de régimen (no
   dirección); LightGBM sobre features de prima/libro/hora. Si en 2 semanas no bate al ingenuo con costos, cerrar.

## Descartar (evidencia negativa clara)

LLMs decidiendo compras (solos o multi-agente); LLMs "descubriendo estrategias"; RL de ejecución (LOXM nunca
publicó TCA; FinRL/JAX-LOB sobreajustan); más modelos fundacionales para precio (TimesFM/Chronos/Moirai/
TimeGPT/FinCast/EXAONE); DeepLOB para scalping (−82% con 1 pb de costo); VPIN; vendedores de señales
(ninguno con auditoría independiente); repos "crypto LSTM" (predicen niveles → ilusión de lag).

## Licencias (para uso productivo)
OK comercial: TimesFM 2.5, Chronos-2/Bolt, TTM-Granite, Kronos (MIT, large cerrado), FinCast, Time-MoE, Sundial.
NO comercial: TimesFM 3.0, Moirai 2.0, EXAONE Finance, TabPFN 2.5+. Pago/cerrado: TimeGPT, mlfinlab.

## Fuentes principales
arXiv 2606.27100 · arXiv 2511.18578 · arXiv 2607.05291 (TSFM vs HAR) · arXiv 2508.02739 (Kronos) +
github.com/imanly97/kronos-evaluation · arXiv 2508.19609 (FinCast) · arXiv 2304.07619 (Lopez-Lira & Tang) ·
arXiv 2505.07078 (FINSABER) · arXiv 2608.27734 · Banxico WP 2021-05 · BIS WP 1340 / IMF WP 2026/056 ·
Talos "Execution alphas" y "Quant Execution Insights 2026" · Amberdata "Rhythm of Liquidity" · Borderless
benchmark · arXiv 2608.21888 · Rossi JEL 2013 · Fed FEDS 2025-089 · Harvey-Liu-Zhu RFS 2016 · Bailey et al.
PBO · Gu-Kelly-Xiu RFS 2020 · qlib benchmarks · Kaggle: Jane Street, DRW, G-Research, Optiver.
(Informes completos de los 5 frentes con URLs: transcripciones de agentes de la sesión 2026-09-17.)
