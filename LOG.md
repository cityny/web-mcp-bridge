# LOG

## 2026-11-02 — Claude (asistente de desarrollo)
- Evaluación inicial del fork. Tests: 4 suites JS OK; `test_bridge.py` OK tras instalar `websockets`.
- Hallazgos DeepSeek: sin reparación de JSON (solo existe en `chatgpt.js`), streaming detectado por crecimiento de texto (2 s), botón enviar por heurística, filtro de razonamiento amplio, `getMessageKey` O(n²), sin tests.
- Decisión: trabajar por pasos (ver TASK.md). Primero higiene del repo y documentación base.
- `server/bridge.log` deja de versionarse (contenía rutas locales del autor original); el archivo local se conserva. Se añade `*.log` a `.gitignore`.

## 2026-11-02 — Claude (asistente de desarrollo) · Paso 2
- La reparación de barras invertidas (`fixString`, `repairBackslashes`) pasa de `chatgpt.js` a `utils.js`. `scanCalls` usa `parseLenient`: primero `JSON.parse` normal y, solo si falla, reintenta con las barras reparadas. Se aplica al fragmento JSON de cada llamada, no al texto entero (menos riesgo con comillas en la prosa).
- Decisión: eliminar `findJsonObjects` y el texto «reparado» que `messageText` añadía en ChatGPT; el parser compartido ya cubre esos casos. Beneficia a DeepSeek, Claude y Gemini sin tocar sus adaptadores.
- Tests nuevos en `tests/test_utils.mjs` (ruta Windows, escapes válidos conservados, comillas tipográficas + barras). Verificado que fallan con el parser anterior.
- Límite conocido: si el JSON roto sigue siendo válido (p. ej. `"C:\new"` se lee como salto de línea) no se detecta. El prompt ya pide usar `/` en rutas.
