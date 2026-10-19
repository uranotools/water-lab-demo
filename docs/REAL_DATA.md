# CSV y gateway de sensores

## CSV

En la interfaz selecciona un archivo CSV UTF-8, declara intervalo de 5, 15 o 60 min y pulsa Importar observaciones. Se crea un run inmutable independiente de los escenarios simulados. No se llama al modelo automáticamente.

Cabeceras exactas: `timestamp,flowLpm` (pueden ir en otro orden). Se admite coma o punto y coma como separador y campos entre comillas. Timestamp ISO con zona horaria; caudal L/min con punto decimal. Celda vacía = dato ausente, nunca cero. Máximo 100 KB y 576 intervalos por captura. Lecturas ordenadas automáticamente; timestamps conflictivos o fuera de cadencia se rechazan. Huecos dentro de la ventana se rellenan con null y se muestran como interrupciones.

```csv
timestamp,flowLpm
2026-01-01T00:00:00Z,0.4
2026-01-01T00:05:00Z,0.5
2026-01-01T00:10:00Z,
```

Este ejemplo ilustra el formato y no procede de hardware. Un archivo importado tiene procedencia CSV declarada; eso no certifica la calibración ni autenticidad del instrumento que lo generó.

## Recepción HTTP

Ejecuta `npm run setup` para añadir `SENSOR_INGEST_TOKEN` a `.env` sin rotar tus credenciales existentes; reinicia el servidor. Este secreto pertenece al gateway del sensor, no al Vault del plugin ni al navegador. El plugin sigue usando LAB_API_TOKEN para leer evidencia.

Tu gateway local (por ejemplo un proceso que reciba desde USB/serial o MQTT) envía:

```http
POST http://127.0.0.1:3020/ingest/readings
Authorization: Bearer <SENSOR_INGEST_TOKEN>
Content-Type: application/json

{"sensorId":"medidor-01","unit":"L/min","samplingMinutes":5,"readings":[{"timestamp":"2026-01-01T00:00:00Z","flowLpm":0.4}]}
```

Reemplaza el timestamp y caudal del ejemplo por las mediciones reales. Se admite un lote por entrega (hasta 2000 lecturas para validar; la ventana de cada sensor conserva los últimos 576 intervalos). No se conecta automáticamente a un dispositivo ni contiene driver serial/MQTT. Mantiene escucha loopback: un dispositivo en otra máquina necesita un gateway local; esta versión no publica el puerto en la LAN.

La respuesta 202 confirma almacenamiento, no análisis del modelo. Reenviar una lectura idéntica no la duplica; cambiar un caudal ya registrado para el mismo timestamp devuelve 409. Una lectura ausente puede completarse posteriormente. El intervalo no se cambia para un sensor existente: usa otro sensorId. Las lecturas fuera de la ventana móvil se descartan.

El dispositivo aparece en la interfaz; pulsa Crear captura para congelar sus observaciones en un run. Nuevas lecturas no cambian esa evidencia ni los informes anteriores. Luego pulsa Investigar con Urano sobre esa captura. El token autentica al gateway que envía el dato, no demuestra que la lectura física sea correcta.

## Interpretación

Las primeras 24 h se usan como referencia, sin asumir que fueron un período sano. Los detectores requieren muestras posteriores para comparar; una captura corta muestra Referencia insuficiente. No se calculan falsos positivos, retraso real ni pérdidas reales para CSV o sensores porque no existe verdad oculta. El contrafactual de reparación no entrega estimaciones si falta referencia o la telemetría está señalada como defectuosa.

Los detectores siguen siendo heurísticos de laboratorio. No hay certificación de fugas ni operación de válvulas. La integración HTTP sí almacena y conecta observaciones externas reales con las herramientas del plugin, pero esta entrega se verifica con lecturas de prueba, sin un sensor físico conectado.
