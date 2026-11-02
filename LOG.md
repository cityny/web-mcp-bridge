# LOG

## 2026-11-02 — Claude (asistente de desarrollo)
- Evaluación inicial del fork. Tests: 4 suites JS OK; `test_bridge.py` OK tras instalar `websockets`.
- Hallazgos DeepSeek: sin reparación de JSON (solo existe en `chatgpt.js`), streaming detectado por crecimiento de texto (2 s), botón enviar por heurística, filtro de razonamiento amplio, `getMessageKey` O(n²), sin tests.
- Decisión: trabajar por pasos (ver TASK.md). Primero higiene del repo y documentación base.
- `server/bridge.log` deja de versionarse (contenía rutas locales del autor original); el archivo local se conserva. Se añade `*.log` a `.gitignore`.
