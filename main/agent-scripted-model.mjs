// S5.2b model-driven acceptance — a DETERMINISTIC agent driver.
//
// A real model is not available inside the headless acceptance harness (no API
// key / no network), so this module acts as the `streamChat` adapter: it has the
// same signature and returns the same `{ stopReason, text, toolUses }` shape. It
// inspects the accumulated Anthropic-style message history to reconstruct what
// the "agent" has already done, then emits the NEXT tool_use — or finishes.
//
// Unlike the Round-10 scripted adapter, this one does NOT build the diagram from a
// hardcoded `candidateFor()`. It genuinely derives the Archify `architecture`
// candidate from the files it reads: `project.listFiles` returns the evidence
// universe, `project.readFile` fetches each source file, and `buildArchitectureFromEvidence`
// turns those (`rel`, `content`) pairs into components + edges. Because the
// candidate is a pure function of the read files, a METAMORPHIC check holds: rename
// a tier directory (api -> worker) in the fixture and the candidate must change to
// match (web/worker/db).
//
// Project-grade guardrails (Round 12 review):
//   - DISCOVERY IS CAPPED: a real repo can have hundreds of source files, but the
//     chat turn allows only MAX_TOOL_CALLS tool uses. The model reads at most
//     MAX_EVIDENCE_FILES relevant source files (sorted, relevant-first), so a 50+
//     file repo does not guarantee TOOL_BUDGET_EXHAUSTED before authoring.
//   - RELEVANCE FILTER: test/mock/generated/build paths are skipped (tests/, __tests__,
//     *.spec.*, *.test.*, dist/, build/, node_modules/, fixtures/, mocks/), so the
//     derived tiers are the actual application, not the test harness.
//   - SCHEMA/EXAMPLE ARE AUTHORITATIVE, NOT DECORATIVE: the model will NOT call
//     archify.author (and thus cannot produce a candidate) unless BOTH the schema
//     and the example getSkillFile reads succeeded AND their content is usable
//     (a parseable JSON object; the example must carry a components[] array). This
//     makes the "schema defines valid fields / example shapes the candidate"
//     claim true, not just asserted.
//
// Sequence it walks (a natural "изучи проект и построй схему" turn):
//   1. project.getStatus        — is a project linked?
//   2. project.listFiles        — gather the file universe
//   3. project.readFile         — for each relevant source file (capped to MAX_EVIDENCE_FILES)
//   4. archify.getSkillFile     — schema (must parse as a JSON object)
//   5. archify.getSkillFile     — example (must parse as a JSON object with components[])
//   6. archify.author           — candidate #1 + an evidence-derived title, but with
//                                 its FIRST component's type deliberately invalidated
//                                 (`gateway` is not in componentType enum)
//   7. archify.author           — repair #1 with runToken + the CLEAN evidence candidate
//   8. finish — the layout IR is in the last author receipt; the scenario projects it
//
// Steps 6→7 exercise the bounded repair loop: the first candidate fails schema
// validation, the CLI returns diagnostics, and the agent re-authors with the
// returned runToken the way a real repair round would. All candidate content is
// drawn from the evidence the model actually read; nothing is hardcoded except the
// deliberate single-type defect it must repair.

import { parseArchifyResult } from './archify-result.mjs';
import { buildArchitectureFromEvidence, srcExt, componentId } from './evidence-builder.mjs';
import { extractAllowedComponentTypes, schemaNeedsCommon } from './schema-resolver.mjs';

// Cap on the number of source files we READ per turn. The chat tool budget is
// MAX_TOOL_CALLS (50); after getStatus/listFiles + 2 getSkillFile + 2 author we
// want room to spare, so 16 evidence reads is a safe ceiling for a deterministic
// harness while still showing a real repo can be bounded.
const MAX_EVIDENCE_FILES = 16;

// Paths that are NOT part of the application architecture (tests, mocks, generated
// or build output, docs/config that are not a tier). A real agent would ignore these
// when reading a project for an architecture diagram.
const IRRELEVANT_SEGMENTS = ['node_modules', 'dist', 'build', 'coverage', 'test', 'tests', '__tests__', '__mocks__', 'fixtures', 'spec', 'e2e', '.next', '.cache'];
const IRRELEVANT_SUFFIXES = ['.test.', '.spec.', '.stories.', '_test.', '_spec.'];

function isRelevantEvidence(rel) {
  const s = String(rel || '').toLowerCase();
  const segs = s.split('/');
  if (segs.some((seg) => IRRELEVANT_SEGMENTS.includes(seg))) return false;
  // ignore files directly in tests/ but keep e.g. src/web/... test helpers out too
  if (IRRELEVANT_SUFFIXES.some((sfx) => s.includes(sfx))) return false;
  // config/scripts that are not a tier (e.g. webpack, vite, jest, tsconfig, docker)
  if (/\.(config|conf)\./.test(s)) return false;
  return true;
}

// A deterministic title for the authored diagram, derived from the linked project
// id (the fixture directory basename) so a rename also changes the title. Returns
// null when NO project is linked, so the caller can fall back to the example's own
// title (the example-title shaping is real, not just asserted), then to 'App'.
function titleFor(history) {
  const status = lastResult(history, 'project.getStatus');
  const projectId = status && status.data && status.data.projectId;
  const base = projectId || null;
  if (!base) return null;
  return String(base).replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) + ' App';
}

function mkCandidate(components, connections, projectTitle, defaults = {}) {
  // Precedence is applied by the CALLER (evidenceCandidate): the schema's declared
  // `const` wins over the example value, which wins over the safe default. Here we
  // only fill any remaining gap with the safe defaults the CLI expects.
  // TITLE PRECEDENCE (explicit): project-derived title wins; the example's title is a
  // fallback ONLY when no project is linked (titleFor returns null then, not a stub).
  const title = projectTitle || (defaults && defaults.title) || 'App';
  const meta = {
    title,
    ...(defaults && defaults.quality_profile ? { quality_profile: defaults.quality_profile } : { quality_profile: 'showcase' }),
  };
  return {
    schema_version: defaults && defaults.schema_version != null ? defaults.schema_version : 1,
    diagram_type: defaults && defaults.diagram_type != null ? defaults.diagram_type : 'architecture',
    meta,
    components,
    connections,
  };
}

// The Archify CLI quality option must MATCH the candidate's meta.quality_profile
// (a single source of truth): the example may set `quality_profile` on the candidate,
// so the tool call should forward that same value rather than always 'showcase'.
function qualityOf(candidate) {
  return (candidate && candidate.meta && candidate.meta.quality_profile) || 'showcase';
}

// The CLEAN evidence candidate. If no source files were read (or none derive
// a valid component), return null so the model can report and stop instead of
// authoring a schema-invalid or empty diagram. The schema's resolved componentType
// enum (from the real $ref graph, not a hand-crafted inline enum) and the example's
// candidate defaults are applied so BOTH genuinely shape the candidate.
function evidenceCandidate(history) {
  const files = readFiles(history);
  if (!files.length) return null;
  const schemaCheck = usesSkillContent(lastSkillContent(history, 'schema'), lastSkillContent(history, 'common-schema'));
  const exampleCheck = usesExampleContent(lastSkillContent(history, 'example'));
  // PRECEDENCE (Round-16 review): the schema's declared `const` is authoritative. The
  // example may only supply schema_version/diagram_type when the schema does NOT pin
  // them — otherwise an example overriding the schema const would produce a candidate
  // the CLI rejects even after a repair round. quality_profile/title still come from
  // the example (they are not schema-constrained).
  const exampleDefaults = (exampleCheck && exampleCheck.defaults) || {};
  const defaults = {
    schema_version: schemaCheck && schemaCheck.schema_version != null
      ? schemaCheck.schema_version
      : (exampleDefaults.schema_version != null ? exampleDefaults.schema_version : 1),
    diagram_type: schemaCheck && schemaCheck.diagram_type != null
      ? schemaCheck.diagram_type
      : (exampleDefaults.diagram_type != null ? exampleDefaults.diagram_type : 'architecture'),
    quality_profile: exampleDefaults.quality_profile,
    title: exampleDefaults.title,
  };
  const built = buildArchitectureFromEvidence(files, {
    allowedComponentTypes: (schemaCheck && schemaCheck.allowedComponentTypes) || undefined,
  });
  if (!built.components.length) return null;
  return mkCandidate(built.components, built.connections, titleFor(history), defaults);
}

// The DELIBERATELY BROKEN candidate: identical to the clean one except the FIRST
// component's `type` is invalidated (not in componentType enum). This guarantees
// the CLI returns a schema/enum diagnostic so the repair round is real.
function brokenCandidate(clean) {
  const components = (clean && clean.components || []).map((c, i) => (i === 0 ? { ...c, type: 'gateway' } : c));
  return { ...clean, components };
}

/**
 * Reconstruct the ordered list of tool_use calls and their parsed results from
 * the Anthropic-style message history.
 *   calls: [{ id, name, input, result }] where `result` is parsed JSON (or null).
 */
function collectHistory(messages) {
  const calls = [];
  const resultsByUseId = new Map();
  for (const m of messages || []) {
    const content = m.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_use') {
          calls.push({ id: block.id, name: block.name, input: block.input || {}, result: null });
        } else if (block && block.type === 'tool_result') {
          resultsByUseId.set(block.tool_use_id, parseArchifyResult(block.content));
        }
      }
    }
  }
  for (const c of calls) {
    if (resultsByUseId.has(c.id)) c.result = resultsByUseId.get(c.id);
  }
  return calls;
}

function lastResult(calls, name) {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].name === name) return calls[i].result || null;
  }
  return null;
}

function called(calls, name, predicate = () => true) {
  return calls.some((c) => c.name === name && predicate(c.input));
}

// The list of ({ rel, content }) the agent has READ, reconstructed from the
// `project.readFile` results in history. Ordered by rel for determinism.
function readFiles(calls) {
  const files = [];
  for (const c of calls) {
    if (c.name !== 'project.readFile') continue;
    const r = c.result;
    if (r && r.ok && r.data && typeof r.data.content === 'string') {
      files.push({ rel: r.data.rel, content: r.data.content });
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

// --- discovery: tier-balanced, bounded evidence planning --------------------

// Round-13 review: the old `filter → slice(0,16) → sort` read the FIRST 16 files
// then sorted, so a big `api/` dir crowded out `web/`/`db/` entirely. We now group
// by module identity (componentId) and round-robin across groups, so every
// discovered module gets at least one file before any module gets a second — a
// bounded, deterministic, REPRESENTATIVE sample of the codebase.
//
// Round-14 review: with >16 modules the round-robin first pass picks the first 16
// alphabetically. We ADD a relevance PRIORITY (manifests/entrypoints, then web/API/
// DB roots, then import-rich modules) so the cap never silently drops the system's
// entrypoint or persistence layers in favour of alphabetically-first utility dirs.
//
// @param listFilesData  the parsed `project.listFiles` data ({ files: [{ rel, … }] })
// @returns string[] the ordered list of rels to READ (deduped, bounded, tier-balanced)

// Relevance priority for a source REL (a file path). Lower is more important. An
// entrypoint/main/index/app/server at a src root or a classic tier root (web/api/db/…)
// is read before a generic feature/utility dir. NOTE: this takes a FILE PATH, not a
// component id — `priorityOf` is applied per rel, and a group's priority is its MIN.
function priorityOf(rel) {
  const s = String(rel || '').toLowerCase();
  const segs = s.split('/');
  const stem = segs[segs.length - 1].replace(/\.[^.]*$/, '');
  const lastDir = segs.length > 1 ? segs[segs.length - 2] : '';
  // Entrypoints. (`package.json` never reaches here: `srcExt()` already filtered
  // non-code files, so there is NO manifest evidence channel in the code path — the
  // manifest/entrypoint claim refers to source entrypoints only, not package.json.)
  if (/package\.json$/.test(s)) return 0;
  if (stem === 'index' && ['web', 'api', 'db', 'server', 'app', 'main'].includes(lastDir)) return 0;
  if (['web', 'api', 'db', 'server'].includes(lastDir)) return 1;
  if (stem === 'main' || stem === 'index' || stem === 'app' || stem === 'server') return 2;
  return 3;
}

// A module group's relevance = the MINIMUM priority across its files: a single
// entrypoint/tier-root file (e.g. `src/zzz-api/index.ts`) must rank the WHOLE module
// ahead of a generic feature dir whose files are all generic.
function groupPriority(rels) {
  return Math.min(...rels.map(priorityOf));
}

export function planEvidenceReads(listFilesData, { maxFiles = MAX_EVIDENCE_FILES } = {}) {
  const files = (listFilesData && Array.isArray(listFilesData.files) && listFilesData.files) || [];
  // A non-positive cap means "read nothing" (not "read one"): the contract returns
  // an empty plan for maxFiles <= 0 (Round-15 edge case).
  if (maxFiles <= 0) return [];
  const source = files
    .map((f) => f.rel)
    .filter((rel) => srcExt(rel) && isRelevantEvidence(rel))
    .sort();
  // Remember each file's relevance BEFORE grouping: priorityOf is a FILE-PATH function,
  // and a module's priority is the min over its files (a `zzz-api/index.ts` entrypoint
  // must lift the whole `zzz-api` module ahead of a generic `a00` feature dir).
  const priorityByRel = new Map(source.map((rel) => [rel, priorityOf(rel)]));

  const groups = new Map(); // module id -> [rels]
  for (const rel of source) {
    const id = componentId(rel);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(rel);
  }
  // Sort each module's files by relevance (entrypoint/tier-root first), then by rel.
  for (const rels of groups.values()) {
    rels.sort((a, b) => priorityByRel.get(a) - priorityByRel.get(b) || a.localeCompare(b));
  }
  // Order groups by their MINIMUM file priority (lowest = most relevant), tie by id.
  const groupIds = [...groups.keys()].sort((a, b) =>
    groupPriority(groups.get(a)) - groupPriority(groups.get(b)) || a.localeCompare(b)
  );

  // Round-robin across modules: take one file per module per pass until the cap.
  const selected = [];
  const seen = new Set();
  for (let i = 0; ; i++) {
    let addedAny = false;
    for (const gid of groupIds) {
      const rels = groups.get(gid);
      if (i >= rels.length) continue;
      const rel = rels[i];
      if (!seen.has(rel)) {
        seen.add(rel);
        selected.push(rel);
        addedAny = true;
      }
      if (selected.length >= maxFiles) break;
    }
    if (!addedAny || selected.length >= maxFiles) break;
  }
  return selected;
}

// The list of source-file relative paths the agent will READ for evidence (bounded
// by MAX_EVIDENCE_FILES, tier-balanced, tests/mocks/generated/build filtered out).
function discoverSourceRels(calls) {
  const res = lastResult(calls, 'project.listFiles');
  const data = (res && res.ok && res.data) || null;
  return planEvidenceReads(data, { maxFiles: MAX_EVIDENCE_FILES });
}

// --- schema/example validation ----------------------------------------------

function parseJsonObject(text) {
  try {
    const obj = JSON.parse(String(text || ''));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// Extract the schema's OWN pinned defaults (the `const` values on the top-level
// `schema_version` / `diagram_type` properties). The example must NOT override these —
// the schema is the source of truth for candidate shape (Round-16 review). A missing
// property yields `undefined` so the caller can fall back to example → safe default.
function schemaDefaults(primarySchema) {
  const p = primarySchema && primarySchema.properties;
  if (!p) return {};
  const version = p.schema_version && p.schema_version.const;
  const diagram = p.diagram_type && p.diagram_type.const;
  return {
    schema_version: typeof version === 'number' ? version : undefined,
    diagram_type: typeof diagram === 'string' ? diagram : undefined,
  };
}

// The schema read must be a REAL JSON Schema for the diagram type: `type: "object"`
// with a `properties` map that declares a `components` array. This is stricter than
// the Round-12 `JSON.parse` gate (which accepted `{nonsense:true}` as usable). When
// the schema constrains the componentType enum — in the REAL Archify schema that is
// expressed as `$ref: "common.schema.json#/$defs/componentType"`, resolved here via
// the loaded `common-schema` — we surface it so the candidate builder applies it.
function usesSkillContent(content, commonContent) {
  const obj = parseJsonObject(content);
  if (!obj) return null;
  if (obj.type !== 'object') return null;
  if (!obj.properties || typeof obj.properties.components !== 'object') return null;
  // Resolve the real $ref graph (common.schema.json) first, then fall back to an
  // inline enum for the test schemas. Both yield an `allowedComponentTypes` array.
  const common = parseJsonObject(commonContent);
  const allowedComponentTypes = extractAllowedComponentTypes(obj, common);
  const defaults = schemaDefaults(obj);
  return { ok: true, allowedComponentTypes, schema_version: defaults.schema_version, diagram_type: defaults.diagram_type };
}

// The example read must model an actual architecture candidate: `diagram_type`
// must be `architecture` AND it must carry a non-empty `components[]` array.
// Beyond the preflight, the example's candidate DEFAULTs (schema_version,
// diagram_type, quality_profile, title) are surfaced so the authored candidate
// genuinely borrows its shape from the example. Without a usable example the
// model will NOT author (content causality, not just availability).
function usesExampleContent(content) {
  const obj = parseJsonObject(content);
  if (!obj) return null;
  if (obj.diagram_type !== 'architecture') return null;
  if (!Array.isArray(obj.components) || obj.components.length === 0) return null;
  const defaults = {
    schema_version: typeof obj.schema_version === 'number' ? obj.schema_version : undefined,
    diagram_type: typeof obj.diagram_type === 'string' ? obj.diagram_type : undefined,
    quality_profile: (obj.meta && obj.meta.quality_profile) || undefined,
    title: (obj.meta && obj.meta.title) || undefined,
  };
  return { ok: true, defaults };
}

// An example is COMPATIBLE with the schema when its schema-pinned fields either don't
// contradict the schema's `const`s or the schema does not pin them. If the example
// declares a `schema_version`/`diagram_type` that conflicts with the schema, authoring
// must STOP (a candidate that contradicts the schema would fail CLI validation even
// after a repair round) — Round-16 review.
function exampleCompatibleWithSchema(exampleDefaults, schemaCheck) {
  if (!exampleDefaults) return true;
  if (!schemaCheck) return true;
  if (schemaCheck.schema_version != null && exampleDefaults.schema_version != null && schemaCheck.schema_version !== exampleDefaults.schema_version) return false;
  if (schemaCheck.diagram_type != null && exampleDefaults.diagram_type != null && schemaCheck.diagram_type !== exampleDefaults.diagram_type) return false;
  return true;
}

function lastSkillContent(calls, kind) {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].name !== 'archify.getSkillFile') continue;
    if ((calls[i].input && calls[i].input.kind) !== kind) continue;
    const r = calls[i].result;
    if (r && r.ok && r.data && typeof r.data.content === 'string') return r.data.content;
    return null; // a failed/absent schema|example read
  }
  return null;
}

/**
 * The scripted model. Signature-compatible with `streamChat`, but `endpoint`,
 * `apiKey`, `signal` are ignored. It only needs `messages` and `tools`.
 */
export async function scriptedArchifyModel({ messages = [], tools = [] }) {
  const history = collectHistory(messages);
  const toolNames = new Set(tools.map((t) => t.name));

  const tool = (name, input) => ({
    stopReason: 'tool_use',
    text: '',
    toolUses: [{ id: `tu-${history.length + 1}-${name}`, name, input }],
  });
  const end = (text) => ({ stopReason: 'end_turn', text, toolUses: [] });

  // 1. Is a project linked?
  if (toolNames.has('project.getStatus') && !called(history, 'project.getStatus')) {
    return tool('project.getStatus', {});
  }
  // 2. List files as evidence universe.
  if (toolNames.has('project.listFiles') && !called(history, 'project.listFiles')) {
    return tool('project.listFiles', {});
  }

  // 3. Read relevant source files, ONE per call, capped. The next file is the first
  //    discovered rel that has NOT been read yet.
  if (toolNames.has('project.readFile')) {
    const rels = discoverSourceRels(history);
    const readRel = new Set(readFiles(history).map((f) => f.rel));
    const next = rels.find((rel) => !readRel.has(rel));
    if (next !== undefined) {
      return tool('project.readFile', { rel: next });
    }
  }

  // Read the schema first (what fields/types are valid). Causality: if the schema
  // read fails or returns unusable content, we do NOT proceed to author. In the real
  // Archify schema the componentType enum lives in common.schema.json and is reached
  // via a local `$ref`, so we ALSO load the common schema, resolve it, and REQUIRE it
  // to succeed when the schema depends on it — a broken common schema is NOT ignored.
  if (toolNames.has('archify.getSkillFile')) {
    if (!called(history, 'archify.getSkillFile', (i) => i.kind === 'schema')) {
      return tool('archify.getSkillFile', { kind: 'schema', type: 'architecture' });
    }
    const schemaContent = lastSkillContent(history, 'schema');
    // Basic schema shape gate: type object + a components property.
    if (!usesSkillContent(schemaContent, null)) {
      return end('Не удалось прочитать Archify schema — authoring остановлен (schema обязателен).');
    }
    if (!called(history, 'archify.getSkillFile', (i) => i.kind === 'common-schema')) {
      return tool('archify.getSkillFile', { kind: 'common-schema', type: 'architecture' });
    }
    const commonContent = lastSkillContent(history, 'common-schema');
    // Resolve the supported local $ref graph (the two Archify componentType reference
    // shapes covered by fixtures). If the schema depends on common and the common
    // schema did not resolve to a usable componentType enum, STOP (causality, not just
    // availability) — otherwise authoring proceeds with no type constraint silently.
    if (schemaNeedsCommon(parseJsonObject(schemaContent)) && !usesSkillContent(schemaContent, commonContent)?.allowedComponentTypes?.length) {
      return end('Не удалось разрешить Archify schema graph — authoring остановлен (common-schema обязателен).');
    }
    if (!called(history, 'archify.getSkillFile', (i) => i.kind === 'example')) {
      return tool('archify.getSkillFile', { kind: 'example', type: 'architecture' });
    }
    const exampleContent = lastSkillContent(history, 'example');
    if (!usesExampleContent(exampleContent)) {
      return end('Не удалось прочитать Archify example — authoring остановлен (example обязателен).');
    }
    // An example that contradicts the schema's pinned consts (e.g. schema says
    // schema_version must be 1 but the example says 2) would yield a candidate the CLI
    // rejects — STOP authoring rather than emit an invalid candidate (Round-16 review).
    const schemaCheck = usesSkillContent(schemaContent, commonContent);
    const exampleCheck = usesExampleContent(exampleContent);
    if (!exampleCompatibleWithSchema(exampleCheck && exampleCheck.defaults, schemaCheck)) {
      return end('Archify example противоречит schema (schema_version/diagram_type) — authoring остановлен.');
    }
  }

  // 6/7. Author — first broken, then repair with the runToken.
  if (toolNames.has('archify.author')) {
    const clean = evidenceCandidate(history);
    const authorCalls = history.filter((c) => c.name === 'archify.author');
    if (authorCalls.length === 0) {
      if (!clean) {
        return end('Не удалось вывести схему из исходников проекта — не найдено ни одного подходящего файла.');
      }
      return tool('archify.author', { type: 'architecture', candidate: brokenCandidate(clean), quality: qualityOf(clean) });
    }
    const last = authorCalls[authorCalls.length - 1];
    const res = last.result;
    if (res && res.ok && res.data && res.data.ir) {
      // Success — the layout IR is ready; finish so the scenario can project it.
      return end('Схема готова: получил layout IR из Archify и подготовил её для проекции на холст.');
    }
    if (res && res.runToken && !called(history, 'archify.author', (i) => !!i.runToken) && clean) {
      // Repair #1: the candidate failed validation; re-author with the runToken.
      return tool('archify.author', {
        type: 'architecture',
        candidate: clean,
        quality: qualityOf(clean),
        runToken: res.runToken,
      });
    }
    // No valid repair path available; bail out gracefully rather than looping.
    return end('Не удалось получить валидный layout IR за отведённое число повторных попыток.');
  }

  // The archify tools are not enabled/available — report it, don't hang.
  return end('Инструменты Archify недоступны на этом ходе.');
}
