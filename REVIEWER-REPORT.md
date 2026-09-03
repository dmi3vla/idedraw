# Отчёт для ревьювера — canvas-v2-rebuild

Дата: 2026-09-03 · Ветка пакета: review-package · Ревьюируемая ревизия: текущее состояние папки

## 1. Что это за проект

Electron-приложение «canvas-v2-rebuild»: независимый холст Excalidraw + независимая
чат-панель, соединённые мостом (IPC), с привязкой к проекту и интеграцией со скиллом
**archify** (генерация проверенных интерактивных HTML-диаграмм архитектуры через LLM).

Ключевые подсистемы:

| Область | Где | Что делает |
|---|---|---|
| Renderer | `src/` | React-точка входа, холст (`src/canvas/mount.jsx`), чат (`src/chat/`), мост (`src/bridge/`), AST-вью (`src/ast-view/`) |
| Main | `main.mjs`, `main/` | Оконный менеджмент, IPC-команды, агентный движок (`main/agent-tool-executor.mjs`), интеграция archify (`main/archify-*.mjs`), AST-якоря (`main/project/`) |
| Скилл archify | **вне репо**: `~/.agents/skills/archify/` | CLI `bin/archify.mjs`: validate/deliver/visual-check схемы-диаграмм |
| Артефакты | `archify-out/`, `artifacts/` | Сгенерированные диаграммы, кандидаты, визуальные доказательства |

## 2. Как проверить (воспроизведение)

```bash
npm install          # node_modules в архив не входит
npm test             # 276/276 тестов — зелёные на момент архива
npm run build        # сборка renderer.bundle (~14MB) — OK
npm start            # electron . --no-sandbox
```

Дополнительные прогоны: `npm run verify:protocol`, `verify:visual`, `verify:pixel`,
`verify:ui`, `verify:saved-chat`, `verify:stress`, `verify:ast-anchor` (см. `package.json`).
Браузерные проверки используют системный Chrome (`/usr/bin/google-chrome`).

## 3. Статус на момент архива

- **Тесты: 276/276 pass** (`npm test`, 2026-09-03).
- **Сборка: OK** (`npm run build`, 2026-09-03).
- **Стоковая генерация archify через CLI скилла: полный цикл проходит** —
  validate (9/9 artifact-checks, composition showcase pass) → deliver → visual-check
  (containment 1366×768, читаемость 8.33px ≥ 6px) в обеих темах. Артефакты в `archify-out/`.

## 4. Последняя итерация: что изменено и зачем

Живой прогон генерации выявил три отказа модели (deepseek-v4-flash-vision-exp):
(1) `meta.views[].note` длиннее 140 символов — лимит схемы;
(2) перенасыщенная раскладка кандидата (fan-out через чужие узлы, 30+ diagnostics);
(3) после исчерпания repair-бюджета модель молча завершала ход → `GENERATION_FAILED`.

Правки приложения (скилл не менялся):

| Файл | Правка | Зачем |
|---|---|---|
| `main/skill-profile.mjs` | дефолт `maxRepairRounds` 2 → 4 | больше раундов на repair по diagnostics (потолок `clampBudget()` = 4) |
| `main.mjs` | промпт генерации усилен контрактом раскладки: 8–10 компонентов, ≤9 связей, одна главная цепочка, зазоры ≥90px, `note` ≤140, править только диагностированное | предотвратить плотные раскладки и schema-отказы |
| `main.mjs` | авто-nudge: если ход завершён без успешного `archify.author`, пайплайн один раз продолжает диалог с подсказкой | спасти «молчаливый» сбой (end_turn с пустым текстом) |

## 5. Интеграция со скиллом archify (вне архива)

- Приложение исполняет **замороженный снапшот скилла** из `~/.agents/skills/archify/`
  (бинарь резолвится main-процессом, модель не поставляет путь — см. `main/archify-author.mjs`).
- Скилл ретаргетнут на единственный desktop-вьюпорт **1366×768** (readability-бюджет 1336px);
  55 тестов скилла зелёные. Это изменение **не входит** в данный архив — лежит в домашнем
  каталоге пользователя.
- Хеш скила приложение подхватывает автоматически; при `acceptedHash: null` повторного
  подтверждения не требуется.

## 6. Артефакты в архиве

- `archify-out/canvas-v2-architecture.html` — финальная интерактивная диаграмма
  (showcase, 9/9 проверок; интерфейс вьюера — фиксированный английский, русского локаля нет).
- `archify-out/candidate.json`, `candidate-v2.json` — замороженные спецификации кандидатов.
- `archify-out/*.visual-check.*` — приёмка: JSON-receipt, contact-sheet, скриншоты light/dark 1366×768.
- `artifacts/` — доказательства предыдущих фаз (AST-anchors, import, projection, pixel/UI proofs).
- `BRIEF-REPORT.md`, `ACCEPTANCE.md`, `ROUND-*.md` — отчёты предыдущих итераций.

## 7. Известные ограничения

- Успех генерации зависит от качества LLM: контрактом раскладки, бюджетом 4 и nudge
  отказы сильно снижены, но не исключены. При `GENERATION_FAILED` — повторить «Обновить».
- `vaInitialize failed` в stderr — безвредное предупреждение VA-API на этой машине.
- Строка `media/gpu/vaapi` и предупреждение esbuild о размере бандла (14MB) не влияют на работу.
- `.git` в пакете отсутствует: проект поставляется как снапшот-папка (см. `make-review-archive.mjs`).

## 8. Состав архива

Архив собран штатным `node make-review-archive.mjs <out.tar.gz>`: без `node_modules`,
`src/dist` (build-артефакт), `userData`, секретов (`*.key`, `*.pem`, `.env`) и служебных
скриптов; dot-папки исключены, кроме `.github`. Корень внутри архива — `review-package/`.
