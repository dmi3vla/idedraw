# Реализация AST overlay и Code Canvas

Дата: 2026-09-03

## Исправлено по фактической проверке

### Контекстное меню

Причина отсутствия пункта «Развернуть AST»: обработчик был передан как произвольный prop в `<Excalidraw>`, но компонент не прокидывает такой обработчик до DOM-холста. Теперь capture-обработчик установлен на React-wrapper вокруг Excalidraw.

- ПКМ по Archify-компоненту перехватывается до штатного меню и показывает «Развернуть AST».
- ПКМ по фону и прочим элементам не перехватывается: остаётся штатное контекстное меню Excalidraw.
- Escape/клик снаружи закрывает меню; фокус возвращается.
- Короткий ЛКМ также может открыть AST; drag с порогом более 5 px не открывает overlay.

### Результат «Развернуть AST»

Вместо узкой боковой панели открывается полноразмерный modal overlay поверх приложения. Excalidraw остаётся смонтированным под ним.

Overlay теперь визуально соответствует прототипу Code Canvas:

- карточки файлов расположены на графовой сцене;
- между карточками рисуются направленные SVG-связи;
- карточка содержит путь, язык, число строк, AST-символы и bounded listing;
- режимы: «Сам узел», «Связи · 1 уровень», «Связи · 2 уровня»;
- до 30 anchor-scoped листингов загружаются параллельно с лимитом 200 строк/16 KiB на preview;
- большие графы доступны через внутреннюю прокрутку сцены;
- кнопка «Открыть» показывает вложенный полноразмерный listing overlay;
- полностью загруженный небольшой файл можно редактировать и атомарно сохранить.

### Безопасность редактора

- renderer не получает и не передаёт абсолютный project root;
- запись разрешена только в существующий текстовый файл активного AST anchor/scope;
- generation и точный project snapshot обязательны;
- stale editor не может перезаписать внешний change;
- path traversal, symlink escape, binary и secret-like paths запрещены;
- после save snapshot и AST-граф пересчитываются.

## Проверки

- `npm test`: 278 total, 272 pass, 0 fail, 6 optional skips.
- `node --check`: main/preload/AST/project-fs — успешно.
- JSX bundle syntax-check с external React/Excalidraw — успешно.
- Визуальный render 1440×900: полноразмерная тёмная графовая сцена, три listing-карточки и SVG-рёбра; overflow/overlay diagnostics отсутствуют, console errors отсутствуют.

## Ограничение среды

Полный `npm run build` требует зависимости исходного проекта. Review-архив намеренно не содержит `node_modules`, а npm-сеть sandbox недоступна. На developer-машине выполнить `npm ci && npm run build && npm start`.

## Round 3 — меню на старых сохранённых холстах

Фактический `architecture.excalidraw` содержит Archify-компоненты с `projectNodeId`, но без `astAnchor` и `evidenceRefs`. Раньше такие узлы не считались доступными для AST, поэтому ПКМ показывал только штатное меню. Теперь eligibility меню определяется по imported component identity (`rectangle + projectNodeId`), а не по наличию anchor. Пункт «Развернуть AST» показывается и на legacy-узлах. Если у старого узла есть evidence refs, строится безопасный own-anchor fallback; если нет — overlay открывается с явным сообщением о необходимости открыть проект и перегенерировать Archify, вместо молчаливого отсутствия пункта.


## Round 4 — production S6 anchors from the skill request

Причина пустых узлов была в несовпадении ключей: production generation уже считала `tierFiles`/`evidenceMap` и `filesManifest`, но эти карты были keyed path-derived id (`bridge`, `project`, `chat`), тогда как модель в успешном Archify IR создавала собственные id (`command_engine`, `store_fs`, `chat_ui`). Projection искал manifest по IR id и получал пусто.

Добавлен `bindEvidenceToArchifyIr(ir, readFiles)` после успешного `archify.author`:

1. повторно строит точные группы файлов только из файлов, реально прочитанных skill-turn;
2. детерминированно связывает каждый model-authored component id/label/type с наиболее релевантной evidence-группой;
3. перекладывает `tierFiles` и `evidenceMap` на реальные id из успешного Archify IR;
4. строит `filesManifest` уже по authored connections, поэтому у каждого узла появляются `own`, dependencies/dependents L1 и L2;
5. передаёт manifest отдельным `projectContext` рядом с IR — Archify JSON и строгая schema не изменяются;
6. projection sanitizes side-channel и записывает только локальный anchor в `customData.archify.astAnchor` каждого узла.

Production log теперь показывает `evidenceCount`, `anchorCount` и безопасные binding summaries. Добавлен regression test с model ids `chat_ui`, `command_engine`, `store_fs`: все получают файлы, а manifest строит правильные L1/L2 переходы.

Проверка: 279 total, 273 pass, 0 fail, 6 optional CLI skips; source/JSX syntax checks — OK.


## Round 5 — AST theme follows the main canvas

У AST Inspector удалена самостоятельная палитра. `#ast-root` теперь напрямую алиасит общие переменные главного окна (`--bg`, `--fg`, `--fg-muted`, `--border`, `--accent`) в AST-переменные. Единственный источник состояния темы остаётся `theme/theme.mjs`; тот же `onThemeChange` одновременно обновляет Excalidraw и AST overlay.

Добавлены корректные `color-scheme: light/dark` для нативного textarea/scrollbar, а caret редактора использует цвет активной темы. Переключение Theme в главном окне действует на header, tabs, dotted canvas, карточки, listing preview и editor без закрытия overlay.

Проверка: 280 total, 274 pass, 0 fail, 6 optional CLI skips; JSX/source syntax — OK.
