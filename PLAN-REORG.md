# План реорганизации — чат как агентный runtime с подключаемыми skills

> Переорганизовано под фактическое состояние `canvas-v2-rebuild`.
> Цель: чат — **общий агентный runtime**, а Archify — **один из skills**
> (`~/.agents/skills/archify/SKILL.md`). Не жёстко зашитый «Archify-чат».

## Ключевое отличие от исходного плана

Исходный план — 10 фаз «сверху вниз». Здесь я разбил на **вертикальные срезы**,
каждый заканчивается работающим + протестированным состоянием, чтобы UI,
безопасность и воспроизводимость появились раньше, чем агент начнёт строить
большие схемы.

Приоритет срезов (то, что делает запрос пользователя, — раньше):

```
S1  Skill registry + store (main)          ← фундамент, чистый Node, тестируемо
S2  IPC: skills:list/get/add/setEnabled    ← мост к renderer
S3  Chat settings: tab "Provider | Skills" ← то, что просил пользователь
S4  Агентный runtime + immutable snapshot  ← чат реально становится агентом
S5  Archify authoring loop                 ← агент пишет candidate + validate + layout
S6  Проекция на холст + HTML export        ← финальный pipeline
S7  Известный дефект: horizontal clipping  ← отложен, дописать после S1-S6
```

---

## S1 — Skill registry + store (main-процесс)

Задача: обнаруживать установленные CLI-скиллы в `~/.agents/skills/*/SKILL.md`,
извлекать frontmatter, считать стабильный sha256, **не активировать без согласия
пользователя**.

### Файлы
- `main/skills/skill-registry.mjs`
  - `parseFrontmatter(md)` → `{ meta, body }` (name, description, license, `metadata.version`).
  - `listDiscovered()` → `[{ id, name, version, path, root, sha256, status }]`.
  - `realpath` root + файла; запрет symlink-escape за `SKILLS_ROOT`.
  - статусы: `ready | missing | invalid | changed | disabled`.
- `main/skills/skill-store.mjs`
  - персистентность: только `{ path, enabled, profileOverride, acceptedHash }`.
  - не копирует и не переписывает установленный `SKILL.md`.
  - по умолчанию регистрирует всё из `~/.agents/skills`.

### Безопасность
- реальный путь через `fs.realpathSync`; отказ по `../` и по `..` в компонентах.
- внешний symlink, выходящий за `SKILLS_ROOT`, не разрешаем.
- включение скилла в prompt — только явное действие пользователя.

### Тесты
- `tests/skill-registry.test.mjs`
  - обнаружение `*/SKILL.md`;
  - парсинг frontmatter (включая `metadata.version` и кавычки);
  - стабильный sha256 между запусками;
  - symlink-escape за root блокируется;
  - статус `missing` для несуществующего пути;
  - `enabled` toggle и `changed` (hash отличается от принятого).

---

## S2 — IPC: skills-поверхность

- `main.mjs`: `registerSkillIpc()` →
  - `skills:list` → все зарегистрированные + дискретные
  - `skills:get(id)` → детали + `SKILL.md` содержимое
  - `skills:addPath(path)` → file/folder dialog в main, регистрация
  - `skills:setEnabled(id, enabled)`
  - `skills:remove(id)`
- `preload.cjs`: `skillsBridge` с этими методами.

---

## S3 — Chat settings: вкладка «Skills»

UI по образцу Zed **list-detail / master-detail settings** + **dynamic Add item**:

```
Настройки
├── Provider  (существующий endpoint/model/key)
└── Skills    (новое)
```

Экран Skills:

```
Skills                          [+ Add Skill]
  ✓ Archify                     Ready
    Architecture diagrams · v2.16
  ○ Another skill              Disabled
```

По выбору Archify — details:

```
Archify
  Status    Ready
  Version   2.16
  Path      ~/.agents/skills/archify
  Hash      ab12…
  Enabled   [✓]
  Profile   Canvas projection · HTML only on request
  [Refresh] [Edit profile] [Remove reference]
```

`Remove reference` убирает регистрацию, **не физическую папку**.
`+ Add Skill` — folder picker через main-process dialog.

---

## S4 — Агентный runtime + immutable snapshot

- При отправке собрать: provider/model/enabled skills/canvas state/linked project.
- Заморозить enabled skills в snapshot `{ skillId, content, sha256, loadedAt }`.
- System prompt в порядке: base policy → target profile → enabled SKILL.md → project context → canvas context.
- Tool set по capabilities, не `if (skill.name === 'archify')`.
- Сhips над composer: `[Claude Sonnet] [Archify] [Project linked]`.
- Замороженный snapshot гарантирует: изменение settings не трогает уже идущий run.

---

## S5 — Archify authoring loop

Сейчас `runArchifyValidate()` работает только с **готовым spec**. CLI сам репозиторий
не анализирует. Автор JSON — агент.

1. Определить type: `architecture|workflow|sequence|dataflow|lifecycle`.
2. Прочитать matching schema + `common.schema.json` + один example.
3. Evidence из project tools (`project.listFiles/readFile/search`).
4. Записать `candidate.json` в `.agent-runs/<runId>/`.
5. `archify validate <type> candidate.json --quality showcase --json`.
6. Максимум 2 focused repair rounds.
7. После успеха — `--layout-json` → resolved IR.
8. **Canvas-режим**: НЕ запускать `deliver → HTML`; вернуть resolved IR.
9. **Export-режим**: отдельная команда `Export → Archify HTML`.

---

## S6 — Проекция на холст

```
resolved layout JSON → importArchifyIR → native frames → nodes → bound arrows → один updateScene
```

- layout из main → renderer через preload IPC.
- сохранить в `customData`: `{ archifyComponentId, archifyType, tag, evidenceRefs, sourceRunId, candidateHash }`.
- перед запуском: `Replace canvas | Merge | New canvas`.
- весь импорт — одна undo-транзакция; после — fit-to-screen + receipt.
- `canvas.getSelection/getNode/getNeighbors/...` — query-инструменты для чата.
- `canvas.addNode/updateNode/removeNode/addEdge/...` — мутации через command registry.

---

## S7 — Известный дефект: horizontal clipping

**Closed (Round 24/25, при живом dark+light pixel proof).**

Дефект: при импорте IR боксы были 150–160px при реальном Virgil-ренде (fontSize 16),
а длинные подписи (`command-registry.mjs`) резались по горизонтали — stored
`text.width` занижал painted glyph extents, поэтому `fitProbe`/`labelProbe`
говорили `fits:true`, а пиксельный probe ловил `overflow`.

Решение (детерминированное, без browser-only `measureText` в projection plan):
- `estimateArchifyLabelWidth()` — построчная оценка с учётом широких/узких glyph;
- `requiredArchifyNodeWidth()` — +36px guard на Excalidraw bound-text padding;
- узлы расширяются только при необходимости, исходный центр сохраняется;
- boundaries расширяются до union с widened members — узел не выходит за frame;
- preview/confirm/receipt используют уже fitted geometry — не расходятся;
- `wrapArchifyLabelText()` — max width 320px + перенос по `/ . - _` (Unicode-safe),
  height растёт с числом строк; ширины capped — «бесконечного роста бокса» нет;
- `applyArchifyRowReflow()` — детерминированный reflow при пересечениях (min gap 32px),
  включён в projection identity до hashing (no-op на чистом лейауте).

**Live-доказательство:** `--scenario=archify-import` dark+light →
`archify-import-pixel-{dark,light}.json -> ok:true`; все 11 узлов `lPad/rPad >= 8`;
`nullExtent` и `overflow` пустые; пересечений widened узлов нет (gap >= 44px);
bindings (labelProbe), arrow rerouting (real drag) и exact Undo/Redo (merge 38→2→38,
replace exact snapshots) — зелёные. `verify:pixel`/CI — красный gate падает job.

---

## Почему такой порядок

Registry → IPC → UI → runtime → authoring → projection — каждый слой заканчивается
тестом и скриншотом, прежде чем агент получит возможность строить и импортировать
большие схемы. Так безопасность и воспроизводимость появляются раньше фичи.

---

## Статус реализации

| Срез | Состояние | Тесты | Доказательство |
|------|-----------|-------|----------------|
| S1 Skill registry + store | ✅ | `tests/skill-registry.test.mjs` | `listDiscovered` находит реальный archify (v2.16) |
| S2 IPC + preload | ✅ | объединено | smoke-test PASS |
| S3 Chat settings «Skills» | ✅ | скриншот `artifacts/skills-ui-{dark,light}.png` | `SKILLS-UI: ALL CHECKS PASSED` |
| S4 Agent runtime + snapshot | ✅ | `composeAgentSystemPrompt`/`enabledSnapshots` | snapshot замораживается ОДИН раз перед tool-loop |
| S4.1 Security closure | ✅ | `tests/project-root.test.mjs`, `tests/archify-author.test.mjs` | никакой root из модели; runToken — непрозрачный UUID; IPC игнорирует caller root |
| S4.1.1 Run state machine hardening | ✅ | `tests/archify-author.test.mjs` (attempt/бюджет/переходы/TTL) | исправлен off-by-one; бюджет профильный и неизменяемый; переходы запрещены для terminal-статусов |
| S4.2 AgentRunContext + receipt | ✅ | `tests/agent-runtime.test.mjs` | main-owned allowlist, tool-gating в `askRendererForTool`, `chat:runReceipt`, profile-budget, cleanup |
| S4.2.1 Frozen Tool Execution | ✅ | `tests/agent-runtime.test.mjs` (+executor) | `project.*`/`archify.*` исполняются в майне по замороженному `ctx` (не по глобальному состоянию); `canvas.*` — renderer |
| S5 Archify authoring (core) | ✅ | `tests/archify-author.test.mjs` | async CLI, bounded repair, run state machine |
| S5.1 Skill-file readers | ✅ | `tests/archify-skill-files.test.mjs` | `archify.getSkillFile` читает schema/example/guide внутри включённого skill |
| S5.2a Deterministic agent-runtime acceptance | ✅ | `tests/agent-scripted-model.test.mjs` | `--scenario=archify-agent`: натуральный запрос → project tools → schema/example → broken candidate → repair w/ runToken → layout IR → canvas (3 узла/2 стрелки) |
| S5.2b Evidence-driven authoring acceptance | ✅ bounded JS/TS fixture-driven (tier aggregation) | `tests/evidence-builder.test.mjs`, `tests/agent-scripted-model.test.mjs` | `buildArchitectureFromEvidence` реально выводит candidate из прочитанных файлов; metamorphic `api→worker ⇒ web/worker/db`; модульная identity отделена от типа, тир-баланс discovery, schema/example причинные (Round 16: schema `const` — precedence над example), бюджет tool-loop; незакрыт только e2e metam + S5.2c |
| S6 Canvas projection (core) | ✅ core | `src/canvas/archify-projection-plan.mjs`, `archify-provenance.mjs`, `archify-preview-state.mjs`, `adapter.applyProjectionPlan`, `canvas.preview/confirm/cancelArchifyProjection`, `--scenario=archify-projection` | preview/confirm/cancel — реальные команды + непрозрачный `previewToken`; preview не мутирует; confirm — одна `updateScene` (history capture ещё требует live proof), token-idempotent + stale-защита по content-fingerprint (move/resize/edit при том же id → stale); реестры ограничены (TTL+cap+clear на link/unlink); `sourceId` иммутабельный + `connection.id` сохраняется; per-node evidenceMap без глобального leak; `projectionId`/`sourceHash` — контент-полные (SHA-256, не 32-битный FNV); `customData.archify` provenance без absolute/secret/source; single-commit инвариант закреплён структурным тестом; live Undo/Redo остаётся hard gate; acceptance использует реальный CLI IR. Не закрыто: React overlay UI (S6.3), receipt state-machine actions (S6.8), live keyboard undo/redo proof (нет `undo`/`redo` на imperative API) |
| S7 horizontal clipping | ✅ closed (Round 26) | `src/canvas/archify-import.mjs` (S7 sizing + wrap + ellipsis + reflow), `requiredArchifyNodeWidthWrapped`, `wrapArchifyLabelText`, `wrapArchifyNodeLines`/`ellipsizeArchifyLine`, `applyArchifyRowReflow`, `run-pixel-proof.mjs`, `--scenario=archify-import` | Детерминированный sizing: `estimateArchifyLabelWidth` (построчный, широкие/узкие glyph), 36px guard, центр сохраняется, boundaries → union с widened members. Pixel gate усилен до `lPad/rPad >= 8`. **Live dark+light proof (Round 26, перегенерирован на живой Electron):** `archify-import-pixel-{dark,light}.json -> ok:true`, все 11 узлов `lPad/rPad >= 8` (min lPad 9 / min rPad 11), `nullExtent`/`overflow` пустые, `layoutSafety.overlapCount === 0`, `layoutSafety.minimumRowGap = 44` (>= 32), PNG есть. P2: max width 320px + перенос по `/ . - _` (Unicode-safe), высота растёт с числом строк, `renderedText` capped до 8 строк с `…`. `applyArchifyRowReflow` — детерминированный reflow с min gap 32px (no-op на чистом лейауте), включён в projection identity до hashing. `verify:visual`/CI через `verify:pixel` — красный pixel gate падает job. Закрыто только после зелёного dark+light proof (Round 26 live evidence). |

### Что закрыто в S4.1 / S5.1 (этот проход — security-first)
- **Main-owned project root**: `main/project/project-root.mjs`; выбор только через
  native dialog `project:chooseDirectory`; read-инструменты используют ТОЛЬКО этот root.
- **Никакого `root` из модели**: `project.*` chat-tools и IPC не принимают путь.
- **Безопасный run token**: `main/archify-runs.mjs` — непрозрачный UUID вместо `runId`;
  `../../outside` трансерация невозможна. Runs в `userData/agent-runs/`, не `cwd`.
- **Проверка capability в main**: `archify.author`/`archify.getSkillFile` отказывают
  (`SKILL_DISABLED`), если Archify skill не включён; бинарь берётся из frozen snapshot
  через `resolveInsideSkillRoot`, не из хардкод-пути.
- **Immutable snapshot**: `runChatTurn` фиксирует `enabledSnapshots()` ОДИН раз до цикла.
- **Async**: `archify-author.mjs` использует `execFile` (не `execFileSync`), с timeout/kill.
- **Bounded repair**: `maxRepairRounds` реально ограничивает попытки; `REPAIR_BUDGET_EXHAUSTED`.
- **P2-фиксы**: `listProjectFiles` теперь корректно флагает `truncated` + использует
  `MAX_PATH_DEPTH`; fingerprint — SHA-256 по (rel + contentHash + size); secret-filter
  точнее (`.env`, `id_rsa`, `credentials.json`, `.pem` — без ложных `keymap`/`keyboard`).

### Что закрыто в этом проходе (S4.1.1 hardening)
- **Off-by-one в attempt**: fresh run теперь создаётся как `attempt: 1`, и `resolveRun`
  записывает `run.attempt` обратно, поэтому квитанция согласована с состоянием. Последовательность:
  initial→1, repair#1→2, repair#2→3, next→`REPAIR_BUDGET_EXHAUSTED` (закреплено тестом).
- **Immutable бюджет**: `maxRepairRounds` читается из профиля Archify skill (через `readSkillProfile`)
  и фиксируется при создании run; продолжение НЕ принимает и не может увеличить лимит —
  `archify.author` больше не принимает `maxRepairRounds` из модели (убран из schema).
- **State machine переходы**: записи несут `diagramType/quality/skillHash/binary`; смена любого из
  них в продолжении → `TRANSITION_FORBIDDEN`, смена skillHash → `SKILL_CHANGED_DURING_RUN`;
  повторное открытие `layout_ready`/`cancelled`/`expired` запрещено.
- **TTL + cleanup**: run имеет `expiresAt` (24h), `cleanupExpired()` и `evictIfOverCap()` (MAX_SESSION_RUNS)
  гасят утечку; запускается при старте; кандидаты в `userData/agent-runs/`, не в `cwd`.
- **Квитанция не течёт внутренними путями**: `candidatePath` больше не возвращается в `data`.
- **Fix для clean-room**: тест `minted a runToken` больше не зависит от установленного CLI;
  `archify-import.test.mjs` не падает на module-load при отсутствии spec (аккуратный `skip`).

### Что закрыто в этом проходе (S4.2 AgentRunContext)
- **`runReceipt` эмитится** (`chat:runReceipt`) в начале хода с `{ model, skills:[{skillId,sha256}],
  allowedCommands, projectLinked, projectSnapshotHash }` — без SKILL.md, без путей, без ключей.
  preload `chatBridge.onRunReceipt` + приёмник в `renderer-entry.jsx` (`window.__lastRunReceipt__`).
- **Main-side tool-gating (AgentRunContext)**: единый main-owned контекст; `allowedCommands` строится
  майном (`agent-allowlist.mjs`); список инструментов пересекается с allowlist; `askRendererForTool`
  отклоняет tool_use вне allowlist ДО передачи в renderer. Capability-фильтр renderer'а — UX,
  а не security-boundary.
- **Исправлен `readSkillProfile()`** (`main/skill-profile.mjs`) — бюджет реально profile-driven;
  закреплено тестом (профиль `maxRepairRounds:1` = ровно одна починка).
- **`binary` обязателен** в `authorArchify` (нет дефолта `ARCHIFY_BIN`).
- **Cleanup реально запускается**: `cleanupStaleRunDirs(appUserData)` при старте (включая
  осиротевшие дисковые каталоги), на интервале, перед созданием нового run.
- **Архив + clean-room**: `make-review-archive.mjs` включён в архив; `package.json` —
  `test`/`verify:source`/`verify:clean`; `smoke-test.mjs --source` (SKIP вместо failure).

### Что закрыто в этом проходе (S5.2b evidence-driven acceptance)

Ревьюер Раунда 10 справедливо отметил: scripted-модель доказывала sequence, но candidate оставался
захардкоженным (`candidateFor` → `web → api → db`). Round 11 закрыл это; **Round 12 довёл до
project-grade** (по замечаниям ревьюера Раунда 11):

- **`main/evidence-builder.mjs`** (новый, чистый): `buildArchitectureFromEvidence(files)` превращает
  `(rel, content)` пары, прочитанные агентом, в компоненты + рёбра. Добавлены schema-обязательные
  `pos`/`size` (CLI отвергает candidate без них при свободном размещении). **Не эмитит `sources`**,
  т.к. CLI при наличии `sources` требует `/meta/repository` — расказ refs идёт отдельно в `evidenceMap`.
- **Aгрегация tier (variant A)**: файлы одного tier (`src/api/{users,orders}.mjs`) → ОДИН component, —
  нет дубликатов id в candidate, `evidenceRefs`/`tierFiles` сохраняют все файлы.
- **Canonical import resolution**: `resolveImport(importerRel, spec, index)` разрешает импорт относительно
  каталога импортирующего файла (не по basename) — `src/api/index.ts` и `src/db/index.ts` больше не
  конфликтуют; `import x from "../api"` разрешается в `src/api/index.*`.
- **`main/agent-scripted-model.mjs`** (переписан): убрал `candidateFor()`. Теперь `project.readFile`
  вызывается для релевантных source-файлов из `project.listFiles`, а candidate строится через
  `buildArchitectureFromEvidence` над реально прочитанными файлами.
- **Schema/example authoritative**: перед authoring обязаны быть читаемы schema (JSON-объект) и example
  (объект с `components[]`); иначе модель НЕ вызывает `archify.author` (causality).
- **Bounded+filtered discovery**: `MAX_EVIDENCE_FILES=16`, `isRelevantEvidence` (пропускает
  test/mock/generated/build/config) — реальный репозиторий не упирается в `MAX_TOOL_CALLS`.
- **Сценарий `archify-agent`** ужесточён: `readFile` в flow; `evidenceDerived` (структурное сравнение
  `{id,type,label}` + `{from,to}` рёбер); `nodesHaveEvidence`; `allEvidenceRead` (каждый evidenceRef
  среди успешных `project.readFile`).
- **Хардненинг tool-loop**: `MAX_TOOL_ROUNDS=20`/`MAX_TOOL_CALLS=50` → `TOOL_BUDGET_EXHAUSTED`
  (проверяется ДО добавления assistant-блока — нет dangling tool_use); ключ `agentTurnContexts` =
  `${sender.id}:${conversationId}` (нет коллизий между окнами).
- **Metamorphic proof**: переименование `api → worker` в fixture даёт `web → worker → db`
  (тот же builder, другое evidence → другая диаграмма).
- **Тесты**: `tests/evidence-builder.test.mjs` (13) + обновлённый `tests/agent-scripted-model.test.mjs`
  — **107 passed, 0 failed, 0 skipped**.

### Что закрыто в этом проходе (Round 13 — module identity + tier-balanced discovery + schema causality)

Ревьюер Раунда 12 нашёл, что имя «project-grade» преждевременно: `src/catalog/index.ts`
и `src/billing/index.ts` оба получали id `index` и ложно объединялись, discovery читал
первые 16 файлов до сортировки (большой `api/` вытеснял `web/`/`db/`), а schema/example
оставались только availability-gate (содержимое не влияло на candidate). Закрыто:

- **Модульная identity отделена от типа** (`main/evidence-builder.mjs`): `componentId(rel)`
  берёт ближайший значимый сегмент каталога (после `src`/`packages`/`apps`/`services`),
  шагая через generic-имена (`index`/`main`/`app`/`server`/`config`/`utils`/…). Поэтому
  `src/catalog/index.ts → catalog`, `src/billing/index.ts → billing` — разных модулей, рёбра
  сохраняются, ложного слияния нет. `src/server/index.ts → server` (fallback), так как над
  ним нет значимого каталога. Тип (`inferType`) определяется отдельно от identity.
- **Schema — причинный, не декоративный**: `buildArchitectureFromEvidence(files,
  { allowedComponentTypes })` отбрасывает модули, чей тип не входит в enum schema
  (с warning). `usesSkillContent` теперь требует `type: "object"` + `properties.components`
  (отклоняет `{nonsense:true}`), а `usesExampleContent` требует `diagram_type ===
  "architecture"` + непустой `components[]`. Пример — `{diagram_type:'architecture'}`
  обязателен, иначе authoring не запускается.
- **Тир-балансный discovery** (`main/agent-scripted-model.mjs`): `planEvidenceReads(listFilesData)`
  группирует исходники по module identity и делает round-robin по группам (≤`MAX_EVIDENCE_FILES`),
  поэтому 12 файлов в `api/` не вытесняют `web/`/`db/`. План детерминирован, каждая module
  получает ≥1 файл до второй порции любой другой.
- **Аcceptance-сценарий ужесточён**: `expectedMatches` — независимый ожидаемый фикстчур
  (`web/api/db` + `web→api`, `api→db`), не выведенный из builder; `planSatisfied` — каждый
  план-файл реально прочитан и `failedReads === 0` (заменяет тавтологический `allEvidenceRead`);
  `nodes3`/`arrows2` защищены от `{ok:false}` (не `TypeError` при ошибке проекции).
- **Tool-budget helper** (`main/tool-budget.mjs`): чистый `wouldExceedToolBudget({rounds,calls,
  nextCalls}, {maxRounds,maxCalls})`; `runChatTurn` вызывает его ДО записи assistant-блока —
  превышение лимита никогда не оставляет dangling `tool_use`; покрыт unit-тестом продолжения.
- **Тесты**: `tools/…` — **124 passed, 0 failed, 0 skipped** (clean-room без CLI: 118 pass / 6 skipped).

### Что закрыто в этом проходе (Round 14 — namespace-aware identity + real $ref schema causality + snapType)

Ревьюер Round 13 подтвердил `catalog/index.ts → catalog` и тир-балансный round-robin, но нашёл
три оставшихся P1/P2: (1) monorepo/nested `src` ломала identity — `apps/web/src/api/index.ts` и
`apps/admin/src/api/index.ts` оба давали `api`, а `packages/*/src/components/Button.tsx` оба давали
`components`; (2) реальная Archify schema использует локальный `$ref` в `common.schema.json`, а не
inline enum — поэтому `allowedComponentTypes` оставался `null`; (3) отбрасывание модуля с недопустимым
типом теряло evidence. Всё три закрыты:

- **Namespace-aware identity** (`main/evidence-builder.mjs`): `componentId` находит рабочее пространство
  (`apps`/`packages`/`libs`/`modules`) и префиксно комбинирует namespace с модульной identity:
  `apps/web/src/api/index.ts → web-api`, `apps/admin/src/api/index.ts → admin-api`,
  `packages/catalog/src/components/Button.tsx → catalog-components`,
  `packages/billing/src/components/Button.tsx → billing-components`. `src/catalog/index.ts → catalog`
  сохраняется (single-app repo). Different apps/packages with identical subdirs no longer falsely merge.
- **Real `$ref` schema causality** (`main/schema-resolver.mjs`): читается `common-schema`
  (`archify.getSkillFile { kind: "common-schema" }`), `resolveRef`/`deref`/`extractAllowedComponentTypes`
  разрешают локальный `$ref` `common.schema.json#/$defs/componentType` и извлекают enum; inline enum — fallback.
- **`snapType` вместо drop** (`main/schema-resolver.mjs`): `buildArchitectureFromEvidence` больше не
  отбрасывает модуль с недопустимым типом; `snapType(inferred, allowed)` подбирает ближайший допустимый
  (сам тип → `external` → first allowed), а при невозможности сохраняет модуль с предупреждением.
  Молчаливого удаления реальных модулей нет; warning выносится в `built.warnings`.
- **Example-`defaults` формируют candidate** (`main/agent-scripted-model.mjs`): `usesExampleContent`
  извлекает `schema_version`/`diagram_type`/`quality_profile`/`title` и прокидывает в `mkCandidate`.
- **Relevance-priority discovery** (`main/agent-scripted-model.mjs`): `priorityOf` сортирует группы
  (manifests/entrypoints → `web`/`api`/`db`/`server` → `index`/`main`/`app` → остальное), поэтому при
  >16 модулях round-robin не вытесняет entrypoint/API/persistence.
- **Тесты**: `node --test` → **124 passed, 0 failed, 0 skipped** (dev-машина с Archify);
  clean-room без CLI → **118 pass / 6 skip**. Устаревшие Round-13 тесты (5 шт.) переведены на новое
  `snap`/`common-schema` поведение — реализация НЕ менялась, чтобы они прошли.

### Что закрыто в этом проходе (Round 16 — schema_version precedence fix)

Ревьюер Round 15 подтвердил priority wiring, failed `common-schema` gate, nested `$ref` и namespace
regression, но назвал единственный REQUIRED P1 перед S6: пример может переопределить `schema_version`
вопреки `const`-ограничению primary schema. Закрыто:

- **Precedence `schema const → example → default`** (`main/agent-scripted-model.mjs`):
  `schemaDefaults(primarySchema)` читает `const` из `properties.schema_version`/`properties.diagram_type`;
  `usesSkillContent` теперь возвращает их вместе с `allowedComponentTypes`. `evidenceCandidate` строит
  `defaults`: schema `const` выигрывает у example, example даёт значение только когда schema его не
  фиксирует, иначе безопасный default (`1`/`architecture`). `quality_profile`/`title` — по-прежнему из
  example. `mkCandidate` переведён на nullish-проверки.
- **Контradiction-гат**: `exampleCompatibleWithSchema(exampleDefaults, schemaCheck)` — если example
  противоречит schema `const` (например schema `{const: 1}`, example `2`), authoring останавливается
  (`end_turn`, `toolUses.length === 0`, `archify.author` не вызывается), вместо эмиссии candidate,
  который CLI отклонит даже после repair.
- **Смягчены чрезмерно сильные комментарии** (`main/schema-resolver.mjs`, `tests/schema-resolver.test.mjs`,
  `main/agent-scripted-model.mjs`): убраны «FULL `$ref` graph», «EXACT current shape pinned … can never
  silently drift»; честно указано, что резолвер поддерживает **две** Archify componentType reference-формы
  и не является общим JSON Schema resolver. В `priorityOf` уточнено: ветка `package.json` — intent-preserving
  (файл фильтруется `srcExt()`), manifest-канала в кодовой ветке нет.
- **Edge-case `planEvidenceReads({ maxFiles: 0 })`** (`main/agent-scripted-model.mjs`): добавлен
  `if (maxFiles <= 0) return [];` — неположительный лимит даёт пустой план (раньше — один файл).
- **Тесты**: `node --test` → **143 passed, 0 failed, 0 skipped** (dev-машина с Archify);
  clean-room без CLI → **137 pass / 6 skip**. Переписан `EXAMPLE DEFAULTS SHAPE THE CANDIDATE`
  (`schema_version` держится schema `const`, меняется только `quality_profile`), добавлен
  `SCHEMA-VERSION PREDECENCE` (example `schema_version: 2` ⇒ `end_turn`, без `archify.author`).

### Что закрыто в этом проходе (Round 15 — priority discovery fix + common-schema causality + regression tests)

Ревьюер Round 15 подтвердил namespace-identity и `common-schema` reader, но нашёл, что два заявленных
исправления Round 14 фактически не работали. Закрыто:

- **`priorityOf` принимал component ID вместо пути файла** (`main/agent-scripted-model.mjs`):
  `priorityOf(groups.get(id))`? Нет — старый код делал `priorityOf(groupId)`, где `groupId` — это `api`/
  `db`/`web-api`, а `priorityOf` ожидал `src/api/index.ts`. Поэтому все группы получали `3` и снова
  сортировались алфавитно. Исправлено: `priorityByRel` считается ДО группировки, файлы каждой группы
  сортируются по `priorityOf(rel)`, а группа — по `groupPriority(rels) = Math.min(...rels.map(priorityOf))`.
  Отдельный entrypoint (`src/zzz-api/index.ts`, priority 2) поднимает весь модуль. Repro: при 18 `aNN` +
  `zzz-api/db/web` план начинается с `zzz-api` и включает все три.
- **`common-schema` был только availability check** (`main/agent-scripted-model.mjs`): проверялся
  `called(…, kind === 'common-schema')`, но не успешность. Если общая схема давала ошибку,
  `usesSkillContent(schema, missingCommon)` возвращал `allowedComponentTypes: null`, и authoring
  продолжался без ограничения типа. Исправлено: `schemaNeedsCommon(primary)` (true при `$ref` в
  `common.schema.json`) + если schema зависит от common И enum не разрешился — authoring останавливается.
- **Resolver не понимал nested `items.$ref`** (`main/schema-resolver.mjs`): `extractAllowedComponentTypes`
  теперь сначала `deref(comps.items)`, поэтому `components.items.$ref → common.$defs.component →
  properties.type.$ref` тоже даёт enum (раньше — `null`). Добавлен `tests/schema-resolver.test.mjs`.
- **Example-title и качество приведены к единому правилу**: `titleFor` возвращает `null` без проекта,
  `mkCandidate` использует `projectTitle ?? exampleTitle ?? 'App'`; `qualityOf(candidate)` sync делает
  `input.quality` равным `candidate.meta.quality_profile`.
- **Namespace + priority regression tests**: Round 14 code был впереди тестов — `priorityOf(groupId)`
  прошёл все тесты именно потому, что не было явных тестов. Добавлены namespace tests (evidence-builder)
  и `>16 modules` priority + `common-schema` failure gate + example-defaults shaping (agent-scripted-model).
- **Тесты**: `node --test` → **142 passed, 0 failed, 0 skipped** (dev-машина с Archify);
  clean-room без CLI → **136 pass / 6 skip**.

### Что НЕ закрыто (честно, не блокирует сборку)
- **S6 визуальный слой** — React overlay preview/confirm UI (S6.3), stale re-preview поток (S6.4),
  receipt state-machine actions `layout_ready → … → applied/cancelled/stale/failed` (S6.8) — впереди.
  Командный слой (`preview`/`confirm`/`cancel` + одна `updateScene` + `customData.archify` provenance)
  реализован и закреплён `--scenario=archify-projection` + unit-тестами.
- **Live keyboard undo/redo proof** — imperative Excalidraw API (0.18.1) не экспортирует `undo`/`redo`;
  single-undo гарантирован одной `updateScene` (structural test), а не headless keyboard наблюдением.
- **Evidence refs**: персистятся в `customData.archify.evidenceRefs` (безопасные, project-relative) per-component
  из `evidenceMap[sourceId]`; узел без собственного evidence опускает поле, а не копирует глобальный список. Точная
  provenance per-edge (какой import дал рёбро) НЕ фабрикуется — edges несут только `sourceElementId`, без `evidenceRefs`.
- **Полный e2e metamorphic** проверен на уровне builder (unit), не на полном пути
  scripted model → CLI → canvas — расширение на S7+.
- **S5.2c живая модель (optional/manual)**: `scriptedArchifyModel` детерминированный — он доказывает
  pipeline runtime + evidence-слой, но не «суждение» конкретной LLM. Живой natural-language прогон
  требует API-ключа и сети; `llm-client.mjs` остаётся явно помеченной заглушкой.
- **S5.2b остаётся bounded JS/TS fixture-driven authoring**: builder поддерживает только
  `.js/.mjs/.cjs/.ts/.tsx/.jsx`, относительные импорты и каталог-модульные id. Не покрыты:
  Python/Go/Rust/Java/C#/Ruby/PHP/Vue/Svelte, path aliases, workspace package imports,
  dynamic `import()`, фреймворк-роутинг/конфигурация. Для чистого «project-grade» это надо
  расширить или явно задокументировать границы.
- **Устаревший сценарий `archify-button`** ссылается на `canvas.runArchifyImport`, которого больше
  нет (команда переименована в `canvas.importArchify`) — сценарий надо обновить или удалить.
- **`archify:validate(specPath)` legacy-путь** всё ещё принимает путь от renderer (но scoped внутри
  main-owned project root). Приоритет — удалить legacy и заменить на идентификатор run-артефакта.
