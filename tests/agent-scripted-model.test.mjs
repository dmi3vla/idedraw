// Tests for the S5.2b model-driven acceptance helpers: archify-result.mjs and
// agent-scripted-model.mjs. These prove the deterministic agent driver is well
// behaved: it reconstructs conversation history, chooses the next tool_use from the
// evidence it has actually read, and exercises the repair loop with the runToken.
// Pure ESM — no Electron boot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArchifyResult } from '../main/archify-result.mjs';
import { scriptedArchifyModel, planEvidenceReads } from '../main/agent-scripted-model.mjs';
import { buildArchitectureFromEvidence } from '../main/evidence-builder.mjs';

// --- parseArchifyResult ------------------------------------------------------

test('parseArchifyResult parses a Bridge-shaped JSON tool_result', () => {
  const res = parseArchifyResult('{"ok":true,"data":{"components":3}}');
  assert.equal(res.ok, true);
  assert.equal(res.data.components, 3);
});

test('parseArchifyResult keeps a failed Bridge result (diagnostics intact)', () => {
  const raw = JSON.stringify({ ok: false, error: { code: 'VALIDATION' }, diagnostics: [{ code: 'schema/enum' }], runToken: 'abc' });
  const res = parseArchifyResult(raw);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'VALIDATION');
  assert.equal(res.diagnostics[0].code, 'schema/enum');
  assert.equal(res.runToken, 'abc');
});

test('parseArchifyResult wraps a plain object without ok as { ok:true, data }', () => {
  const res = parseArchifyResult('{"ir":{"components":[]}}');
  assert.equal(res.ok, true);
  assert.equal(res.data.ir.components.length, 0);
});

test('parseArchifyResult wraps plain text as data and tolerates empty input', () => {
  assert.equal(parseArchifyResult('just text').ok, true);
  assert.equal(parseArchifyResult('just text').data, 'just text');
  assert.equal(parseArchifyResult('').ok, false);
  assert.equal(parseArchifyResult(null).ok, false);
});

// --- message construction helpers (consistent tool_use id <-> tool_result id) --

let seq = 0;
function ctx() {
  const id = `tu-${++seq}`;
  return { id, name: '', input: {} };
}

// Build one complete "turn": an assistant tool_use message + a user tool_result
// message whose tool_use_id matches the assistant block's id.
function turn(name, input, content) {
  const c = ctx();
  const assistant = { role: 'assistant', content: [{ type: 'tool_use', id: c.id, name, input }] };
  const user = { role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, content }] };
  return [assistant, user];
}

// --- scriptedArchifyModel ----------------------------------------------------

function authorResult(ok) {
  if (ok) {
    return JSON.stringify({
      ok: true,
      data: {
        runToken: 'rt-success',
        runId: 'rt-success',
        attempt: 2,
        status: 'layout_ready',
        ir: { diagram_type: 'architecture', components: [{ id: 'web' }, { id: 'api' }, { id: 'db' }], connections: [{ id: 'a' }, { id: 'b' }] },
      },
    });
  }
  return JSON.stringify({
    ok: false,
    error: { code: 'VALIDATION', message: 'bad' },
    diagnostics: [{ code: 'schema/enum' }],
    runToken: 'rt-broken',
    runId: 'rt-broken',
    attempt: 1,
    status: 'validation_failed',
  });
}

// The tools offered to the model — the same filter the chat panel + allowlist apply.
const TOOLS = [
  'project.getStatus', 'project.listFiles', 'project.readFile',
  'archify.getSkillFile', 'archify.author',
].map((name) => ({ name }));

// A valid project.listFiles result mirroring the on-disk fixture-project.
function listFilesResult() {
  return JSON.stringify({
    ok: true,
    data: {
      root: '/tmp/fixture',
      files: [
        { rel: 'src/web/app.mjs', size: 120, mtime: 1 },
        { rel: 'src/api/server.mjs', size: 150, mtime: 2 },
        { rel: 'src/db/index.mjs', size: 90, mtime: 3 },
        { rel: 'README.md', size: 10, mtime: 4 },
      ],
      total: 4,
      truncated: false,
    },
  });
}

// A valid project.readFile result for a given rel, mirroring fixture content.
function readFileResult(rel) {
  const contentByRel = {
    'src/web/app.mjs': `import { apiBase } from '../api/server.mjs';\nexport const origin = 'https://app.example.dev';\nexport function boot() { console.log('spa boot @', apiBase); }`,
    'src/api/server.mjs': `import { query, dsn } from '../db/index.mjs';\nexport const port = 8080;\nexport const apiBase = 'http://localhost:' + port;\nexport async function handle(req) { const rows = await query('select 1'); return { port, rows, dsn }; }`,
    'src/db/index.mjs': `export function query(sql) { return Promise.resolve({ rows: [{ sql }] }); }\nexport const dsn = 'postgres://user:pass@db:5432/app';`,
  };
  return JSON.stringify({ ok: true, data: { rel, path: '/tmp/fixture/' + rel, lines: 6, truncated: false, content: contentByRel[rel] } });
}

// Realistic Archify schema/example content. The schema mirrors the REAL Archify
// architecture.schema.json: the component type is referenced via a local `$ref` into
// common.schema.json (`$defs/componentType`), NOT an inline enum. The model must be
// able to load the schema AND the common schema, resolve the `$ref`, and extract the
// componentType enum — that is the Round-14 `$ref` causality fix.
const COMPONENT_TYPES = ['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external'];
function schemaContent() {
  return JSON.stringify({
    type: 'object',
    required: ['schema_version', 'diagram_type', 'meta', 'components'],
    properties: {
      schema_version: { const: 1 },
      diagram_type: { const: 'architecture' },
      meta: { type: 'object', required: ['title'] },
      components: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'type', 'label'],
          properties: {
            id: { $ref: 'common.schema.json#/$defs/id' },
            type: { $ref: 'common.schema.json#/$defs/componentType' },
            label: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  });
}
function commonSchemaContent() {
  return JSON.stringify({
    $defs: {
      id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' },
      componentType: { enum: COMPONENT_TYPES },
    },
  });
}
function exampleContent() {
  return JSON.stringify({
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'Sample', quality_profile: 'showcase' },
    components: [{ id: 'web', type: 'frontend', label: 'Web' }],
    connections: [],
  });
}
function skillResult(kind, content) {
  return JSON.stringify({ ok: true, data: { content } });
}

// The full "agent already read all evidence" prefix used by authoring tests. It now
// includes the `common-schema` read (the Round-14 $ref causality step) between the
// schema and the example, matching the real scripted flow.
function evidencePrefix() {
  return [
    ...turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true,"root":"/tmp/fixture","projectId":"fixture"}}'),
    ...turn('project.listFiles', {}, listFilesResult()),
    ...turn('project.readFile', { rel: 'src/api/server.mjs' }, readFileResult('src/api/server.mjs')),
    ...turn('project.readFile', { rel: 'src/db/index.mjs' }, readFileResult('src/db/index.mjs')),
    ...turn('project.readFile', { rel: 'src/web/app.mjs' }, readFileResult('src/web/app.mjs')),
    ...turn('archify.getSkillFile', { kind: 'schema', type: 'architecture' }, skillResult('schema', schemaContent())),
    ...turn('archify.getSkillFile', { kind: 'common-schema', type: 'architecture' }, skillResult('common-schema', commonSchemaContent())),
    ...turn('archify.getSkillFile', { kind: 'example', type: 'architecture' }, skillResult('example', exampleContent())),
  ];
}

test('scriptedArchifyModel returns the next tool_use per step, walking project evidence first', async () => {
  const start = await scriptedArchifyModel({ messages: [{ role: 'user', content: 'построй схему' }], tools: TOOLS });
  assert.equal(start.toolUses[0].name, 'project.getStatus');

  const s2 = await scriptedArchifyModel({
    messages: [{ role: 'user', content: 'x' }, ...turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true}}')],
    tools: TOOLS,
  });
  assert.equal(s2.toolUses[0].name, 'project.listFiles');

  // After listFiles, the model begins reading source files (relevant-first: a tier
  // root/entrypoint like db/index.mjs outranks api/server.mjs, then web/app.mjs).
  const s3 = await scriptedArchifyModel({
    messages: [{ role: 'user', content: 'x' },
      ...turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true}}'),
      ...turn('project.listFiles', {}, listFilesResult()),
    ],
    tools: TOOLS,
  });
  assert.equal(s3.toolUses[0].name, 'project.readFile');
  assert.equal(s3.toolUses[0].input.rel, 'src/db/index.mjs', 'reads the highest-priority source rel first');

  // After the last read, the model moves to the schema.
  const readsDone = [
    ...turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true,"root":"/tmp/fixture","projectId":"fixture"}}'),
    ...turn('project.listFiles', {}, listFilesResult()),
    ...turn('project.readFile', { rel: 'src/db/index.mjs' }, readFileResult('src/db/index.mjs')),
    ...turn('project.readFile', { rel: 'src/api/server.mjs' }, readFileResult('src/api/server.mjs')),
    ...turn('project.readFile', { rel: 'src/web/app.mjs' }, readFileResult('src/web/app.mjs')),
  ];
  const s4 = await scriptedArchifyModel({
    messages: [{ role: 'user', content: 'x' }, ...readsDone],
    tools: TOOLS,
  });
  assert.equal(s4.toolUses[0].name, 'archify.getSkillFile');
  assert.equal(s4.toolUses[0].input.kind, 'schema');
});

test('scriptedArchifyModel authors a broken candidate first, then repairs with runToken, derived from evidence', async () => {
  const beforeAuthor = [{ role: 'user', content: 'x' }, ...evidencePrefix()];

  // First author call -> broken candidate derived from the read evidence.
  const first = await scriptedArchifyModel({ messages: beforeAuthor, tools: TOOLS });
  assert.equal(first.toolUses[0].name, 'archify.author');
  const broken = first.toolUses[0].input.candidate;
  assert.equal(broken.components[0].type, 'gateway', 'first candidate is deliberately invalid');
  // The rest of the candidate must be evidence-derived: web/api/db + pos/size.
  const ids = broken.components.map((c) => c.id).sort();
  assert.deepEqual(ids, ['api', 'db', 'web']);

  // Feed the broken result (failed with runToken) -> the model must repair.
  const afterFail = [...beforeAuthor, ...turn('archify.author', { type: 'architecture', candidate: broken, quality: 'showcase' }, authorResult(false))];
  const second = await scriptedArchifyModel({ messages: afterFail, tools: TOOLS });
  assert.equal(second.toolUses[0].name, 'archify.author');
  assert.equal(second.toolUses[0].input.runToken, 'rt-broken', 'repair reuses the runToken');
  const repair = second.toolUses[0].input.candidate;
  assert.equal(repair.components[0].type, 'frontend', 'repair candidate is valid');
  assert.deepEqual(repair.components.map((c) => c.id).sort(), ['api', 'db', 'web']);
  assert.equal(repair.components[0].pos[0], 40, 'repair candidate has deterministic pos');
});

test('scriptedArchifyModel finishes with end_turn after a successful author (no IR tool leak)', async () => {
  const predone = [
    ...evidencePrefix(),
    ...turn('archify.author', { type: 'architecture', candidate: {}, quality: 'showcase' }, authorResult(true)),
  ];
  const messages = [{ role: 'user', content: 'x' }, ...predone];
  const res = await scriptedArchifyModel({ messages, tools: TOOLS });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.toolUses.length, 0);
  assert.match(res.text, /layout IR/i);
});

test('scriptedArchifyModel stops cleanly when no source files were read', async () => {
  // listFiles returns only a README (not a source tier) -> no readFile, no author.
  const onlyMd = [
    ...turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true}}'),
    ...turn('project.listFiles', {}, JSON.stringify({ ok: true, data: { files: [{ rel: 'README.md', size: 10, mtime: 1 }], total: 1, truncated: false } })),
    ...turn('archify.getSkillFile', { kind: 'schema', type: 'architecture' }, skillResult('schema', schemaContent())),
    ...turn('archify.getSkillFile', { kind: 'common-schema', type: 'architecture' }, skillResult('common-schema', commonSchemaContent())),
    ...turn('archify.getSkillFile', { kind: 'example', type: 'architecture' }, skillResult('example', exampleContent())),
  ];
  const res = await scriptedArchifyModel({ messages: [{ role: 'user', content: 'x' }, ...onlyMd], tools: TOOLS });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.toolUses.length, 0);
  assert.match(res.text, /Не удалось вывести схему|не найдено ни одного/i);
});

// Sanity: the evidence-driven candidate the model would author is CLI-valid shape
// (pos/size present, ids schema-valid, no `sources` that would require metadata).
test('scriptedArchifyModel authors a candidate with CLI-satisfiable geometry', async () => {
  const beforeAuthor = [{ role: 'user', content: 'x' }, ...evidencePrefix()];
  const first = await scriptedArchifyModel({ messages: beforeAuthor, tools: TOOLS });
  const broken = first.toolUses[0].input.candidate;
  // Every component: schema-valid id, valid type enum (except the broken one), pos/size arrays.
  const types = new Set(['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external']);
  for (const c of broken.components) {
    assert.match(c.id, /^[a-zA-Z][a-zA-Z0-9_-]*$/);
    assert.ok(types.has(c.type) || c.type === 'gateway'); // only the broken one is out-of-enum
    assert.ok(Array.isArray(c.pos) && c.pos.length === 2);
    assert.ok(Array.isArray(c.size) && c.size.length === 2);
    assert.equal(c.sources, undefined, 'no sources field leaks into the candidate');
  }
  // And buildArchitectureFromEvidence reconstructs the same id set from the read files.
  const files = ['src/web/app.mjs', 'src/api/server.mjs', 'src/db/index.mjs'].map((rel) => {
    const data = JSON.parse(readFileResult(rel)).data;
    return { rel: data.rel, content: data.content };
  });
  const built = buildArchitectureFromEvidence(files);
  assert.deepEqual(built.components.map((c) => c.id).sort(), broken.components.map((c) => c.id).sort());
});

// Round-12 causality: schema/example are AUTHORITATIVE. If either read fails or its
// content is unusable, the model must NOT call archify.author (it ends instead).
test('scriptedArchifyModel does not author when the schema read is broken', async () => {
  const readsDone = [
    ...turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true,"root":"/tmp/fixture","projectId":"fixture"}}'),
    ...turn('project.listFiles', {}, listFilesResult()),
    ...turn('project.readFile', { rel: 'src/api/server.mjs' }, readFileResult('src/api/server.mjs')),
    ...turn('project.readFile', { rel: 'src/db/index.mjs' }, readFileResult('src/db/index.mjs')),
    ...turn('project.readFile', { rel: 'src/web/app.mjs' }, readFileResult('src/web/app.mjs')),
    // schema read FAILS -> must stop before author.
    ...turn('archify.getSkillFile', { kind: 'schema', type: 'architecture' }, '{"ok":false,"error":{"code":"BROKEN_SCHEMA"}}'),
  ];
  const res = await scriptedArchifyModel({ messages: [{ role: 'user', content: 'x' }, ...readsDone], tools: TOOLS });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.toolUses.length, 0);
  assert.match(res.text, /schema/i);
  assert.ok(!res.toolUses.length);
});

test('scriptedArchifyModel does not author when the example content lacks components', async () => {
  const readsDone = [
    ...turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true,"root":"/tmp/fixture","projectId":"fixture"}}'),
    ...turn('project.listFiles', {}, listFilesResult()),
    ...turn('project.readFile', { rel: 'src/api/server.mjs' }, readFileResult('src/api/server.mjs')),
    ...turn('project.readFile', { rel: 'src/db/index.mjs' }, readFileResult('src/db/index.mjs')),
    ...turn('project.readFile', { rel: 'src/web/app.mjs' }, readFileResult('src/web/app.mjs')),
    ...turn('archify.getSkillFile', { kind: 'schema', type: 'architecture' }, skillResult('schema', schemaContent())),
    ...turn('archify.getSkillFile', { kind: 'common-schema', type: 'architecture' }, skillResult('common-schema', commonSchemaContent())),
    // example content is a bare object with NO components[] -> unusable -> must stop.
    ...turn('archify.getSkillFile', { kind: 'example', type: 'architecture' }, '{"ok":true,"data":{"content":"{}"}}'),
  ];
  const res = await scriptedArchifyModel({ messages: [{ role: 'user', content: 'x' }, ...readsDone], tools: TOOLS });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.toolUses.length, 0);
  assert.match(res.text, /example/i);
});

// --- ROUND 13: tier-balanced discovery ---------------------------------------

// A real listFiles with a big api/ dir that would previously crowd out web/db.
function crowdedListFiles() {
  const files = [
    { rel: 'src/web/app.mjs', size: 100, mtime: 1 },
    { rel: 'src/db/index.mjs', size: 90, mtime: 1 },
    // 12 api files — the old slice(0,16) would read ONLY these and never web/db.
    ...Array.from({ length: 12 }, (_, i) => ({ rel: `src/api/f${String(i).padStart(2, '0')}.mjs`, size: 10, mtime: 1 })),
    { rel: 'README.md', size: 10, mtime: 1 },
  ];
  return files;
}

test('planEvidenceReads is tier-balanced: a big api/ dir does not crowd out web/db', () => {
  const plan = planEvidenceReads({ files: crowdedListFiles() });
  // Every discovered module must be represented in the plan.
  const byDir = new Set(plan.map((r) => r.split('/')[1]));
  assert.ok(byDir.has('web'), 'web is in the plan');
  assert.ok(byDir.has('db'), 'db is in the plan');
  assert.ok(byDir.has('api'), 'api is in the plan');
  // Bounded by MAX_EVIDENCE_FILES (16) and each module contributes at least one.
  assert.ok(plan.length <= 16, `plan bounded (${plan.length} <= 16)`);
  // Deterministic: same input -> same plan.
  assert.deepEqual(plan, planEvidenceReads({ files: crowdedListFiles() }));
});

test('planEvidenceReads returns the canonical fixture plan (relevant-first: db index, api, web)', () => {
  const plan = planEvidenceReads(JSON.parse(listFilesResult()).data);
  // `src/db/index.mjs` is an entrypoint (stem index + db tier root) so it is the
  // highest-priority rel, before api/server.mjs and web/app.mjs.
  assert.deepEqual(plan, ['src/db/index.mjs', 'src/api/server.mjs', 'src/web/app.mjs']);
});

// --- ROUND 13: schema/example are CAUSAL, not an availability gate ------------

function readsForSchema(schemaContent) {
  return [
    ...turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true,"root":"/tmp/fixture","projectId":"fixture"}}'),
    ...turn('project.listFiles', {}, listFilesResult()),
    ...turn('project.readFile', { rel: 'src/api/server.mjs' }, readFileResult('src/api/server.mjs')),
    ...turn('project.readFile', { rel: 'src/db/index.mjs' }, readFileResult('src/db/index.mjs')),
    ...turn('project.readFile', { rel: 'src/web/app.mjs' }, readFileResult('src/web/app.mjs')),
    ...turn('archify.getSkillFile', { kind: 'schema', type: 'architecture' }, skillResult('schema', schemaContent)),
    ...turn('archify.getSkillFile', { kind: 'common-schema', type: 'architecture' }, skillResult('common-schema', commonSchemaContent())),
    ...turn('archify.getSkillFile', { kind: 'example', type: 'architecture' }, skillResult('example', exampleContent())),
  ];
}

test('scriptedArchifyModel does NOT author a non-JSON-Schema `{nonsense:true}` schema', async () => {
  const res = await scriptedArchifyModel({ messages: [{ role: 'user', content: 'x' }, ...readsForSchema(JSON.stringify({ nonsense: true }))], tools: TOOLS });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.toolUses.length, 0);
  assert.match(res.text, /schema/i);
});

test('scriptedArchifyModel does NOT author a schema without a components property', async () => {
  const res = await scriptedArchifyModel({ messages: [{ role: 'user', content: 'x' }, ...readsForSchema(JSON.stringify({ type: 'object', properties: { title: { type: 'string' } } }))], tools: TOOLS });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.toolUses.length, 0);
  assert.match(res.text, /schema/i);
});

test('scriptedArchifyModel authors a candidate DERIVED (and schema-filtered) from evidence when the schema constrains the enum', async () => {
  // Schema only allows frontend + backend -> db (database) is SNAPPED to the nearest
  // allowed type (frontend), NOT silently dropped. So the candidate still contains
  // web/api/db — db simply wears a compatible type rather than vanishing. A
  // dropped-module implementation would surface only ['api','web'] here, which the
  // snap behaviour now catches as a regression.
  const constrainedSchema = JSON.stringify({
    type: 'object',
    properties: {
      components: {
        type: 'array',
        items: { type: 'object', properties: { type: { enum: ['frontend', 'backend'] } } },
      },
    },
  });
  const res = await scriptedArchifyModel({ messages: [{ role: 'user', content: 'x' }, ...readsForSchema(constrainedSchema)], tools: TOOLS });
  assert.equal(res.toolUses[0].name, 'archify.author');
  const ids = res.toolUses[0].input.candidate.components.map((c) => c.id).sort();
  // db is kept (snapped to a schema-allowed type), not dropped.
  assert.deepEqual(ids, ['api', 'db', 'web']);
});

test('scriptedArchifyModel does NOT author an example without diagram_type architecture', async () => {
  const reads = readsForSchema(schemaContent());
  // Replace the example read with one that has components but wrong diagram_type.
  const badExample = reads.slice(0, -1).concat([
    ...turn('archify.getSkillFile', { kind: 'example', type: 'architecture' }, '{"ok":true,"data":{"content":"{\"components\":[{\"id\":\"x\"}]}"}}'),
  ]);
  const res = await scriptedArchifyModel({ messages: [{ role: 'user', content: 'x' }, ...badExample], tools: TOOLS });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.toolUses.length, 0);
  assert.match(res.text, /example/i);
});

// --- ROUND 15: priority discovery + common-schema causality + example shaping ---

// A listFiles with 18 alphabetically-early generic modules plus three important
// tier entrypoints that sit LATE alphabetically. Under the Round-13 bug, the group
// sort called priorityOf(componentId) — a GROUP ID — so `zzz-api`/`zzz-db`/`zzz-web`
// got priority 3 and were crowded out by EVERY `aNN` generic dir. Round-15 fixes
// priorityOf(rel) per-file and groupPriority(min over files), so the tier roots win.
function crowdedGenericListFiles() {
  const files = [];
  for (let i = 0; i < 18; i++) files.push({ rel: `src/a${String(i).padStart(2, '0')}/worker.ts`, size: 10, mtime: 1 });
  // Important tier entrypoints, alphabetically LAST.
  files.push({ rel: 'src/zzz-api/index.ts', size: 10, mtime: 1 });
  files.push({ rel: 'src/zzz-db/index.ts', size: 10, mtime: 1 });
  files.push({ rel: 'src/zzz-web/index.ts', size: 10, mtime: 1 });
  return { files, total: files.length, truncated: false };
}

test('PRIORITY: with >16 modules, zzz-api/db/web entrypoints are NOT crowded out by aNN generic dirs', () => {
  const plan = planEvidenceReads(crowdedGenericListFiles());
  // The important tier entrypoints must be READ. (Round-13 bug: they were skipped.)
  assert.ok(plan.includes('src/zzz-api/index.ts'), 'zzz-api index is selected');
  assert.ok(plan.includes('src/zzz-db/index.ts'), 'zzz-db index is selected');
  assert.ok(plan.includes('src/zzz-web/index.ts'), 'zzz-web index is selected');
  // And they are read BEFORE the generic aNN modules (group priority = min file priority).
  assert.equal(plan[0], 'src/zzz-api/index.ts');
  // Deterministic + bounded.
  assert.ok(plan.length <= 16, `plan bounded (${plan.length} <= 16)`);
  assert.deepEqual(plan, planEvidenceReads(crowdedGenericListFiles()));
});

test('COMMON-SCHEMA CAUSALITY: a schema that needs common stops authoring when common fails', async () => {
  // The REAL schema schemaContent() points componentType at common.schema.json via $ref.
  // If the common-schema read FAILS (unusable), authoring must STOP — a broken common
  // schema is a hard dependency, not silently ignored.
  const readsDone = [
    ...turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true,"root":"/tmp/fixture","projectId":"fixture"}}'),
    ...turn('project.listFiles', {}, listFilesResult()),
    ...turn('project.readFile', { rel: 'src/api/server.mjs' }, readFileResult('src/api/server.mjs')),
    ...turn('project.readFile', { rel: 'src/db/index.mjs' }, readFileResult('src/db/index.mjs')),
    ...turn('project.readFile', { rel: 'src/web/app.mjs' }, readFileResult('src/web/app.mjs')),
    ...turn('archify.getSkillFile', { kind: 'schema', type: 'architecture' }, skillResult('schema', schemaContent())),
    // common-schema read FAILS -> the $ref graph cannot be resolved.
    ...turn('archify.getSkillFile', { kind: 'common-schema', type: 'architecture' }, '{"ok":false,"error":{"code":"BROKEN_COMMON"}}'),
  ];
  const res = await scriptedArchifyModel({ messages: [{ role: 'user', content: 'x' }, ...readsDone], tools: TOOLS });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.toolUses.length, 0);
  assert.match(res.text, /common-schema|schema/i);
});

// Build the author-candidate for a given example content, reusing the canonical
// evidence prefix so the ONLY variable is the example.
async function authorWithExample(exampleObj) {
  const messages = [{ role: 'user', content: 'x' }].concat(
    turn('project.getStatus', {}, '{"ok":true,"data":{"linked":true,"root":"/tmp/fixture","projectId":"fixture"}}'),
    turn('project.listFiles', {}, listFilesResult()),
    turn('project.readFile', { rel: 'src/api/server.mjs' }, readFileResult('src/api/server.mjs')),
    turn('project.readFile', { rel: 'src/db/index.mjs' }, readFileResult('src/db/index.mjs')),
    turn('project.readFile', { rel: 'src/web/app.mjs' }, readFileResult('src/web/app.mjs')),
    turn('archify.getSkillFile', { kind: 'schema', type: 'architecture' }, skillResult('schema', schemaContent())),
    turn('archify.getSkillFile', { kind: 'common-schema', type: 'architecture' }, skillResult('common-schema', commonSchemaContent())),
    turn('archify.getSkillFile', { kind: 'example', type: 'architecture' }, skillResult('example', JSON.stringify(exampleObj))),
  );
  return scriptedArchifyModel({ messages, tools: TOOLS });
}

test('EXAMPLE DEFAULTS SHAPE THE CANDIDATE: quality_profile flows, schema_version held by schema const', async () => {
  // Both examples use schema_version 1 (matching the schema's `const: 1`); only
  // quality_profile varies. The schema const is authoritative for schema_version
  // (Round-16 review), while quality_profile still comes from the example.
  const a = await authorWithExample({ schema_version: 1, diagram_type: 'architecture', meta: { title: 'Sample', quality_profile: 'showcase' }, components: [{ id: 'web', type: 'frontend', label: 'Web' }], connections: [] });
  const b = await authorWithExample({ schema_version: 1, diagram_type: 'architecture', meta: { title: 'Sample', quality_profile: 'standard' }, components: [{ id: 'web', type: 'frontend', label: 'Web' }], connections: [] });
  assert.equal(a.toolUses[0].name, 'archify.author');
  assert.equal(b.toolUses[0].name, 'archify.author');
  const ca = a.toolUses[0].input.candidate;
  const cb = b.toolUses[0].input.candidate;
  assert.equal(ca.schema_version, 1);
  assert.equal(cb.schema_version, 1);
  assert.equal(ca.meta.quality_profile, 'showcase');
  assert.equal(cb.meta.quality_profile, 'standard');
  // The CLI quality option is SINGLE-SOURCED from the candidate (no divergence).
  assert.equal(a.toolUses[0].input.quality, 'showcase');
  assert.equal(b.toolUses[0].input.quality, 'standard');
});

test('SCHEMA-VERSION PRECEDENCE: an example contradicting the schema const does NOT author', async () => {
  // The schema pins `schema_version: { const: 1 }`; an example that tries to override
  // it with 2 must STOP before archify.author — otherwise the candidate would fail CLI
  // validation even after a repair round (Round-16 review).
  const res = await authorWithExample({ schema_version: 2, diagram_type: 'architecture', meta: { title: 'Sample', quality_profile: 'showcase' }, components: [{ id: 'web', type: 'frontend', label: 'Web' }], connections: [] });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.toolUses.length, 0);
  assert.match(res.text, /schema|example/i);
  // Crucially, archify.author is never reached.
  assert.equal(res.toolUses.filter((t) => t.name === 'archify.author').length, 0);
});
