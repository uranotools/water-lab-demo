# Informe de investigación v1

El plugin solicita JSON puro al modelo en cada invocación y al iniciar la sesión. El formatter HTTP publica `response` (original), `report` (estructura validada) y `reportError`. SSE y status conservan el texto del core; la demo aplica el mismo contrato antes de mostrar las secciones. La demo comprueba además el hash y la pertenencia de los índices al run consultado.

Si el modelo antepone narración sobre herramientas o rodea el JSON con Markdown, el lector extrae los objetos completos respetando strings y escapes, y selecciona el único informe que pasa las validaciones. No repara JSON incompleto ni inventa campos. Varios informes válidos distintos se consideran ambiguos. El resumen SSE también puede mostrarse después de una introducción. Los informes guardados se vuelven a interpretar al consultar el estado local, sin una nueva invocación del modelo.

```json
{
  "schemaVersion": "water-lab.report.v1",
  "runId": "ID exacto de get_evidence",
  "evidenceId": "hash exacto de get_evidence",
  "summary": "Resumen claro en español, escrito primero para mostrarlo en vivo.",
  "diagnosis": "insufficient_data",
  "severity": "low",
  "confidence": "low",
  "findings": [{"sampleIndices": [0, 1], "statement": "Interpretación respaldada por estas muestras."}],
  "uncertainties": ["No existe inspección física de la instalación."],
  "nextChecks": ["Obtener un período de referencia completo."],
  "recommendations": [{"priority": "low", "action": "Continuar registrando lecturas", "reason": "Falta referencia suficiente."}]
}
```

diagnosis: `normal`, `possible_leak`, `sensor_fault`, `usage_change`, `insufficient_data`. severity, confidence y priority: `low`, `medium`, `high`. Todas las listas son obligatorias; pueden estar vacías salvo sampleIndices dentro de un hallazgo. Máximo 20 elementos por lista; máximo 20 índices por hallazgo. summary hasta 4000 caracteres; textos de secciones hasta 2000. El borrador/transporte está acotado a 64000 caracteres.

La interfaz presenta resumen, diagnóstico provisional, prioridad, confianza cualitativa, evidencia con lecturas obtenidas del dataset, incertidumbres, siguientes pruebas y acciones propuestas. Puede exportar el JSON validado. Si la estructura o las referencias fallan, muestra un error de formato y permite inspeccionar la respuesta original: no inventa un reporte de reemplazo.

La validación garantiza estructura y referencias, no la corrección semántica de cada frase. confidence es una autoevaluación cualitativa del modelo, no probabilidad calibrada. La fuente, timestamps y caudales mostrados junto a las referencias se obtienen del run inmutable. No se toma texto del modelo como HTML.
