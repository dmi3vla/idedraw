// S5.2b Evidence-driven candidate builder.
//
// This is the pure, deterministic "understanding" layer for the scripted agent.
// It is NOT a hardcoded diagram — it derives the Archify `architecture` candidate
// from the actual project files the agent read. Component ids/types/labels are
// inferred from each file's relative path + content, and edges are inferred from
// the import/reference graph between the discovered files.
//
// It is deliberately pure (no fs, no Electron) so it can be unit-tested and, most
// importantly, so a METAMORPHIC check can run: given the same fixture with a tier
// directory renamed (api -> worker), the produced candidate must change to match.
//
// PROJECT-GRADE notes:
//   - Module IDENTITY and component TYPE are SEPARATE. The id is the nearest
//     meaningful directory segment (componentId); the type is inferred from path +
//     content (inferType). So src/catalog/index.ts -> catalog (NOT index) and
//     src/billing/index.ts -> billing — distinct modules that never false-merge.
//   - A real repository usually has MANY files per module (api/users.mjs, api/orders.mjs,
//     db/users.mjs, …). Rather than emitting a duplicate component id per file — which
//     the CLI rejects and which collapses evidence — we AGGREGATE every file of the same
//     module into ONE component (variant A). The representative file drives type/sublabel;
//     every file of the module is still recorded in `evidenceRefs`.
//   - Imports are resolved against the IMPORTING FILE's directory, not by basename
//     ("index" collisions between src/api/index.ts and src/db/index.ts are impossible).
//     `resolveImport` tries the exact resolved path plus the `path/index.*` and
//     extension-candidate forms, keyed by a canonical path index built from all read
//     source rels.
//   - The Archify schema is CAUSAL, not decorative: when it constrains the componentType
//     enum, `buildArchitectureFromEvidence(files, { allowedComponentTypes })` SNAPS any
//     module whose inferred type is not in that enum to the nearest allowed type (never
//     silently drops real evidence), surfacing a warning in `warnings`.
//
// NOTES on schema validity (verified against the real CLI `validate --layout-json`):
//   - When `layout.mode` is omitted the CLI requires an explicit `pos:[x,y]` AND
//     `size:[w,h]` on every component (free placement). We assign deterministic
//     positions from the sorted component order so the candidate always validates.
//   - We deliberately do NOT emit a `sources` field per component: the CLI runtime
//     turns that into a `Repository evidence requires /meta/repository` error. The
//     evidence file refs are instead returned in the `evidenceRefs` array above the
//     candidate, and the acceptance check maps node id -> evidence file by the
//     builder's own id/path relationship, not by leaking absolute paths into the
//     candidate or the receipt.

import path from 'node:path';
import { snapType } from './schema-resolver.mjs';
import { buildAstAnchorManifest } from './project/ast-anchor-manifest.mjs';

// Source extensions we treat as evidence (the "code" we read). Config/markdown
// files are deliberately NOT turned into components — they are not a system tier.
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const SRC_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];

// Deterministic tier ranking so the diagram renders frontend -> backend -> data.
const RANK = {
  frontend: 0,
  security: 1,
  backend: 2,
  cloud: 3,
  messagebus: 4,
  database: 5,
  external: 6,
};

// Tier keywords -> componentType. The FIRST match (in order) wins. A purely
// content-based fallback keeps the heuristic honest (not just path-based).
const TYPE_RULES = [
  { type: 'database', re: /(^|\/)(db|database|store|repo|repos|models?|migrations?)(\/|\.|$)|postgres|mysql|redis|sqlite|mongodb/ },
  { type: 'messagebus', re: /(^|\/)(queue|mq|kafka|bus|worker|worker-?pool|stream)(\/|\.|$)|amqp|rabbitmq|sqs|kafka/ },
  { type: 'security', re: /(^|\/)(auth|security|gateway|sso|oauth|jwt)(\/|\.|$)|jwt|oauth|authoriz/ },
  { type: 'cloud', re: /(^|\/)(cdn|cloud|s3|bucket|static|fronts?)(\/|\.|$)|cloudfront|s3\./ },
  { type: 'frontend', re: /(^|\/)(web|app|ui|client|frontend|spa|renderer|screen|view|pages?)(\/|\.|$)|browser|fetch\(|axios|react|document\.|localStorage/ },
  { type: 'backend', re: /(^|\/)(api|server|service|services|backend|controller|handler|gateway-api)(\/|\.|$)|express|fastify|fastapi|flask|listen\(|:80\d\d|\bport\b/ },
];

// Module-identity roots. A directory at/under these is a container (the repo
// source root, a monorepo package dir, a test/support tree) — NOT a module. When
// searching for a module identity we stop at the first one we hit, so the id is
// always a real application module and never something like `src` or `tests`.
const MODULE_STOP = new Set([
  'src', 'packages', 'apps', 'services', 'lib', 'pkg',
  'test', 'tests', '__tests__', '__mocks__', 'fixtures', 'ssr', 'serverless',
  'node_modules', 'dist', 'build', 'coverage', 'out', 'public', 'static', 'assets',
]);

// Workspace namespace roots: a directory at/under these holds MULTIPLE apps or
// packages, so the segment immediately BELOW it is the namespace that must be
// incorporated into the module identity to keep two apps/packages distinct:
//   apps/web/src/api/index.ts       -> web-api
//   apps/admin/src/api/index.ts     -> admin-api
//   packages/catalog/src/api/index.ts -> catalog-api
// Without this, `apps/web` and `apps/admin` (or `packages/catalog`/`billing`)
// with the same subdir would falsely collapse to a single `api`/`components`.
const WORKSPACE_ROOTS = new Set(['apps', 'packages', 'libs', 'modules']);

// Segment names that name a ROLE/kind of file, not a module. They are walked
// THROUGH (skipped) when locating the module identity, so `src/catalog/index.ts`
// and `src/billing/index.ts` do NOT both collapse to `index` — the nearest
// meaningful directory wins. A generic segment is only used as a fallback id when
// no meaningful directory exists above it (so `src/app/profile.ts` -> `app`).
const GENERIC_SEGMENT = new Set([
  'index', 'main', 'app', 'server', 'client', 'config', 'utils', 'helpers',
  'common', 'shared', 'core', 'components', 'component', 'hooks', 'types',
  'constants', 'routes', 'route', 'router', 'view', 'views', 'pages', 'page',
  'features', 'feature', 'screens', 'screen', 'styles', 'stylesheets', 'style',
]);

function lower(s) {
  return String(s || '').toLowerCase();
}

// Directory segments of a rel path, excluding the file name itself.
function dirSegments(rel) {
  return String(rel || '').split('/').slice(0, -1).filter(Boolean);
}

// Lowercase + sanitize a segment into a schema-valid component id, or null.
function normalizeId(raw) {
  const id = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) ? id : null;
}

// The app/package name when the path sits under a workspace root (apps/packages/…).
// `apps/web/src/...` -> `web`; `packages/catalog/src/...` -> `catalog`. Returns
// null when the path is a single-app repo (no workspace namespace).
function findWorkspaceNamespace(segs) {
  for (let i = 0; i < segs.length - 1; i++) {
    if (WORKSPACE_ROOTS.has(lower(segs[i])) && segs[i + 1]) {
      return lower(segs[i + 1]);
    }
  }
  return null;
}

// The module identity WITHIN a directory chain: the nearest meaningful segment,
// walking from the file's own directory upward, skipping generic role names and
// stopping before a module root. Returns a lowercase segment or null.
function moduleIdentity(dirs, stem) {
  // 1) Nearest non-generic, non-stop segment = the module identity.
  for (let i = dirs.length - 1; i >= 0; i--) {
    const seg = lower(dirs[i]);
    if (MODULE_STOP.has(seg)) break; // do not climb above a container root
    if (!GENERIC_SEGMENT.has(seg)) return seg;
  }
  // 2) Everything was generic/stop — fall back to the nearest non-stop segment
  //    (the immediate parent directory), even if generic, so a file sitting
  //    directly under a role dir still gets an identity rather than null.
  for (let i = dirs.length - 1; i >= 0; i--) {
    const seg = lower(dirs[i]);
    if (!MODULE_STOP.has(seg)) return seg;
  }
  // 3) No directory at all — use the file stem, but never a bare generic role.
  if (stem && !GENERIC_SEGMENT.has(lower(stem))) return lower(stem);
  return null;
}

export function srcExt(rel) {
  return SRC_EXT.has(requireExt(rel));
}

function requireExt(rel) {
  const i = String(rel || '').lastIndexOf('.');
  return i >= 0 ? String(rel).slice(i) : '';
}

// Strip the final extension from a path (keeps directory names intact).
function stripExt(rel) {
  const s = String(rel || '');
  const slash = s.lastIndexOf('/');
  const dot = s.lastIndexOf('.');
  return dot > slash ? s.slice(0, dot) : s;
}

/**
 * Module identity for a source file — a stable, schema-valid id that groups every
 * file of the same module into ONE component. This is SEPARATE from the component
 * TYPE (inferType classifies frontend/backend/database from path + content).
 *
 * Identity is the NEAREST meaningful directory segment, but in a workspace
 * (apps/packages/…) it is PREFIXED with the app/package namespace so two apps or
 * packages with the same internal subdirectory never falsely merge. So:
 *   src/web/app.mjs                          -> web
 *   src/api/users.mjs                        -> api
 *   src/db/index.mjs                         -> db
 *   src/catalog/index.ts                     -> catalog   (NOT index)
 *   src/billing/index.ts                     -> billing   (NOT index)
 *   src/server/index.ts                      -> server    (fallback generic)
 *   apps/web/src/api/index.ts                -> web-api    (NOT api)
 *   apps/admin/src/api/index.ts              -> admin-api  (NOT api)
 *   packages/catalog/src/components/Button.tsx -> catalog-components
 *   packages/billing/src/components/Button.tsx -> billing-components
 *   src/utils/date.ts                        -> utils     (fallback generic)
 */
export function componentId(rel) {
  const dirs = dirSegments(rel);
  const stem = (String(rel || '').split('/').pop() || '').replace(/\.[^.]*$/, '');

  const ns = findWorkspaceNamespace(dirs);
  const sub = moduleIdentity(dirs, stem);

  // Workspace app/package: always namespace-prefix so identical subdirs across
  // two apps/packages stay distinct. If there is no distinct sub-module (a file
  // directly under the package src/), use the namespace alone.
  if (ns) {
    if (!sub || sub === ns) return normalizeId(ns);
    return normalizeId(`${ns}-${sub}`);
  }

  return normalizeId(sub);
}

/** Infer componentType from path + content (import specifiers are stripped so a
 * referenced `<other>/db/…` doesn't reclassify a file as a database). */
export function inferType(rel, content) {
  // Remove import/require specifiers and URL strings: they reference OTHER tiers
  // and must not determine THIS file's type.
  const body = String(content || '')
    .replace(/(?:from\s*|import\s*|require\s*\(\s*)['"][^'"]+['"]/g, ' ')
    .replace(/https?:\/\/[^\s'")]+/g, ' ');
  const text = lower(rel + ' ' + body);
  for (const rule of TYPE_RULES) if (rule.re.test(text)) return rule.type;
  return 'external';
}

/** A short evidence-derived sublabel (e.g. a port, or the DB engine). */
export function extractSublabel(rel, content, type) {
  const t = lower(content);
  if (type === 'database') {
    if (/postgres/.test(t)) return 'pg';
    if (/mysql/.test(t)) return 'mysql';
    if (/redis/.test(t)) return 'redis';
    if (/mongo/.test(t)) return 'mongo';
  }
  const port = /:(\d{2,5})/.exec(t);
  if (port) return ':' + port[1];
  return null;
}

function titleCase(s) {
  const lowered = String(s || '').toLowerCase();
  return lowered ? lowered[0].toUpperCase() + lowered.slice(1) : s;
}

/** Extract import/require specifiers (relative path strings) from a file. */
export function importSpecifiers(content) {
  const out = [];
  const re = /(?:from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content || ''))) out.push(m[1]);
  return out;
}

/**
 * Build a canonical path index from the read source rels so an import can be
 * resolved against the IMPORTING file's directory, not by basename.
 *   key -> rel   where key is the rel with its extension stripped, and a directory
 *   that has an index file also maps to that index (so `import x from "../api"`
 *   resolves to `src/api/index.mjs`).
 */
function buildCanonicalIndex(sourceFiles) {
  const index = new Map();
  for (const f of sourceFiles) {
    const base = stripExt(f.rel);
    index.set(base, f.rel);
    if (base.endsWith('/index')) index.set(base.slice(0, -6), f.rel); // dir -> index
  }
  return index;
}

/** Resolve `spec` imported from `importerRel` to a source rel, or null. */
export function resolveImport(importerRel, spec, canonicalIndex) {
  if (!canonicalIndex) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importerRel), spec));
  const joinedNoExt = stripExt(joined);
  const candidates = new Set([
    joinedNoExt,
    joinedNoExt + '/index',        // join + index file
    stripExt(joined),
    stripExt(joined) + '/index',
  ]);
  for (const c of candidates) {
    if (canonicalIndex.has(c)) return canonicalIndex.get(c);
  }
  return null;
}

/**
 * Build an architecture candidate from read source files. Files of the SAME tier
 * are aggregated into ONE component (variant A) so a real multi-file repository
 * does not emit duplicate component ids.
 *
 * @param files [{ rel, content }] — the files the agent read (already fetched).
 * @param opts { allowedComponentTypes?: string[] } — an optional componentType
 *        enum pulled from the Archify schema. When supplied, components whose
 *        inferred type is NOT allowed are dropped (with a warning), so the schema
 *        genuinely constrains the candidate rather than being decorative.
 * @returns { components, connections, evidenceRefs, evidenceMap, tierFiles, warnings }
 */
export function buildArchitectureFromEvidence(files, opts = {}) {
  const warnings = [];
  const allowedTypes = opts && Array.isArray(opts.allowedComponentTypes) && opts.allowedComponentTypes.length
    ? new Set(opts.allowedComponentTypes)
    : null;
  const sourceFiles = (files || []).filter((f) => srcExt(f.rel)).slice().sort((a, b) => a.rel.localeCompare(b.rel));
  if (!sourceFiles.length) {
    return { components: [], connections: [], evidenceRefs: [], evidenceMap: {}, tierFiles: {}, filesManifest: { version: 1, components: {} }, warnings: ['No source files found to derive an architecture.'] };
  }

  const canonical = buildCanonicalIndex(sourceFiles);
  const fileToComp = new Map(); // rel -> component (its tier)
  const tierFiles = {};         // id -> [rels]
  const components = [];
  const evidenceRefs = [];

  // Aggregate files into tier groups, one component per tier.
  const groups = new Map(); // id -> [{ rel, content }]
  for (const f of sourceFiles) {
    const id = componentId(f.rel);
    if (!id) {
      warnings.push(`Skipped ${f.rel}: no derivable component id.`);
      continue;
    }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(f);
  }

  for (const [id, fs] of groups) {
    // Type: prefer the first non-external inference across the module's files.
    let type = 'external';
    let typeFile = fs[0];
    for (const f of fs) {
      const t = inferType(f.rel, f.content);
      if (t !== 'external') { type = t; typeFile = f; break; }
    }
    // Schema causality: if the Archify schema constrains the componentType enum,
    // SNAP the inferred type to the nearest allowed one instead of silently dropping
    // real modules. If inference was wrong (or the schema enum is narrower), the
    // module stays visible with a compatible type + a warning — we never erase
    // evidence just because a heuristic guessed a disallowed type.
    if (allowedTypes && !allowedTypes.has(type)) {
      const snapped = snapType(type, [...allowedTypes]);
      if (!snapped) {
        warnings.push(`Skipped module ${id}: no compatible type in schema (allowed: ${[...allowedTypes].join(', ')}).`);
        continue;
      }
      warnings.push(`Module ${id}: type "${type}" snapped to "${snapped}" (schema allows: ${[...allowedTypes].join(', ')}).`);
      type = snapped;
    }
    const sublabel = extractSublabel(typeFile.rel, typeFile.content, type) || undefined;
    const comp = {
      id,
      type,
      label: titleCase(id),
      ...(sublabel ? { sublabel } : {}),
    };
    comp._repRel = typeFile.rel;
    components.push(comp);
    tierFiles[id] = fs.map((f) => f.rel).sort();
    evidenceRefs.push(...fs.map((f) => f.rel));
    for (const f of fs) fileToComp.set(f.rel, comp);
  }

  // Edges: component A -> B if A's content imports/references B's tier. Imports are
  // resolved against the importing file's directory via the canonical index.
  const connections = [];
  const seen = new Set();
  for (const f of sourceFiles) {
    const from = fileToComp.get(f.rel);
    if (!from) continue;
    for (const spec of importSpecifiers(f.content)) {
      const targetRel = resolveImport(f.rel, spec, canonical);
      if (!targetRel) continue;
      const to = fileToComp.get(targetRel);
      if (!to || to.id === from.id) continue;
      const key = `${from.id}->${to.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        connections.push({ id: `${from.id}-${to.id}`, from: from.id, to: to.id });
      }
    }
  }

  // Deterministic render order: frontend -> ... -> external, then by id.
  components.sort((a, b) => (RANK[a.type] ?? 99) - (RANK[b.type] ?? 99) || a.id.localeCompare(b.id));

  // Assign SCHEMA-REQUIRED free-placement geometry. The CLI rejects a candidate
  // that omits layout.mode but also omits pos/size; give each component a stable,
  // non-overlapping slot derived only from its sorted index (frontend..external).
  const SIZE = [120, 60];
  const GAP = 40; // horizontal gap between tiers
  const STEP = SIZE[0] + GAP;
  const START = 40; // left margin
  const Y = 100;

  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    c.pos = [START + i * STEP, Y];
    c.size = SIZE.slice();
  }

  // id -> [evidence file rels] for that component. EVERY file that contributed to
  // a component is mapped (tierFiles already holds the full array), so the S6
  // projection plan can write per-component evidenceRefs. The values must be
  // ARRAYS — the projection plan feeds them through sanitizeEvidenceRefs() which
  // drops non-arrays, so a single string would silently produce zero refs (the
  // E2E agent scenario observed evidenceNodes: 0 for this reason). The map never
  // leaks absolute paths; the candidate/ receipt keep no `sources` array.
  const evidenceMap = {};
  for (const c of components) {
    if (tierFiles[c.id] && tierFiles[c.id].length) evidenceMap[c.id] = tierFiles[c.id].slice();
  }
  const filesManifest = buildAstAnchorManifest(tierFiles, connections);

  return {
    components: components.map(({ _repRel, ...rest }) => rest),
    connections,
    evidenceRefs: evidenceRefs.slice().sort(),
    evidenceMap,
    tierFiles,
    filesManifest,
    warnings,
  };
}


// S6 production side-channel binder. The Archify JSON stays schema-pure: this
// aligns model-authored component ids to exact files after successful authoring,
// then sends the manifest beside the IR for projection into customData.
export function bindEvidenceToArchifyIr(ir, files, opts = {}) {
  const built = buildArchitectureFromEvidence(files, opts);
  const components = Array.isArray(ir?.components) ? ir.components : [];
  const sourceByRel = new Map((files || []).map((file) => [file.rel, String(file.content || '')]));
  const groups = (built.components || []).map((group) => {
    const refs = built.tierFiles?.[group.id] || [];
    const searchable = [group.id, group.label, group.type, ...refs,
      ...refs.map((rel) => sourceByRel.get(rel)?.slice(0, 12000) || '')].join(' ').toLowerCase();
    return { id: group.id, type: group.type, refs: refs.slice(), searchable };
  }).filter((group) => group.refs.length);

  const tokens = (value) => [...new Set(String(value || '').toLowerCase()
    .split(/[^a-zа-я0-9]+/u).filter((token) => token.length >= 2))];
  const score = (component, group) => {
    const id = String(component?.id || '').toLowerCase();
    const ownTokens = tokens([component?.id, component?.label, component?.sublabel, component?.type].join(' '));
    let value = id === group.id ? 1000 : 0;
    if (id.length >= 3 && (group.searchable.includes(id) || id.includes(group.id))) value += 180;
    for (const token of ownTokens) {
      if (token === group.id) value += 120;
      else if (group.searchable.includes(token)) value += 18;
    }
    if (component?.type && component.type === group.type) value += 24;
    return value;
  };

  const tierFiles = {};
  const evidenceMap = {};
  const bindings = [];
  for (const component of components) {
    const ranked = groups.map((group) => ({ group, score: score(component, group) }))
      .sort((a, b) => b.score - a.score || a.group.id.localeCompare(b.group.id));
    const winner = ranked[0] || null;
    const refs = winner?.group?.refs || [];
    if (refs.length) {
      tierFiles[component.id] = refs.slice();
      evidenceMap[component.id] = refs.slice();
    }
    bindings.push({ componentId: component.id, evidenceGroupId: winner?.group?.id || null,
      score: winner?.score || 0, fileCount: refs.length });
  }

  const filesManifest = buildAstAnchorManifest(tierFiles,
    Array.isArray(ir?.connections) ? ir.connections : []);
  const unbound = bindings.filter((item) => item.fileCount === 0).map((item) => item.componentId);
  return {
    evidenceRefs: [...new Set(Object.values(evidenceMap).flat())].sort(),
    evidenceMap,
    tierFiles,
    filesManifest,
    bindings,
    warnings: [...(built.warnings || []),
      ...(unbound.length ? [`No S6 evidence for: ${unbound.join(', ')}`] : [])],
  };
}
