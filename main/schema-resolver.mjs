// Schema causality — resolve the supported local Archify JSON Schema references so the
// component TYPE enum is extracted from the actual schema where it is expressed as a
// local `$ref` into common.schema.json, not from a hand-crafted inline enum. The real
// `architecture.schema.json` points `components.items.properties.type` (or the whole
// `components.items`) at `common.schema.json#/$defs/componentType` via a local `$ref`.
// This module resolves those two LOCAL reference shapes against the loaded
// `common.schema.json` and surfaces the enum the same way the CLI enforces it.
// It is NOT a general JSON Schema resolver (no allOf/oneOf/anyOf/remote refs) — it
// covers the two Archify componentType reference shapes covered by the fixtures.
//
// Pure (no fs, no Electron) so it can be unit-tested. It does NOT validate a
// candidate — it only extracts the type constraint a schema implies, which is what
// feeds `buildArchitectureFromEvidence(files, { allowedComponentTypes })`.

/**
 * Resolve a schema `$ref` that references a sibling schema file (`file.json#/$defs/x`)
 * against the JSON `document` of that file, returning the referenced node or null.
 * Only LOCAL, single-file `#/$defs/...` refs are supported (the actual Archify shape).
 */
export function resolveRef(ref, common) {
  if (typeof ref !== 'string' || !common || typeof common !== 'object') return null;
  const hash = ref.indexOf('#');
  const filePart = hash >= 0 ? ref.slice(0, hash) : ref;
  const pointer = hash >= 0 ? ref.slice(hash + 1) : '';
  // Only resolve refs into the common schema (or same-document `#/...`).
  const isCommon = filePart === '' || filePart.endsWith('common.schema.json') || filePart.endsWith('common.json');
  if (!isCommon) return null;
  if (pointer.startsWith('/$defs/')) {
    const key = decodeURIComponent(pointer.slice('/$defs/'.length));
    return (common.$defs && common.$defs[key]) || null;
  }
  // A bare `#/...` pointer (same doc): walk it.
  let node = common;
  for (const part of pointer.split('/').filter(Boolean).map(decodeURIComponent)) {
    if (node && typeof node === 'object' && part in node) node = node[part];
    else return null;
  }
  return node !== common ? node : null;
}

/**
 * Climb from a schema node through `$ref` chains to a concrete definition.
 * Returns the first node whose `.enum` (or `.type`) is directly expressed.
 */
export function deref(node, common, seen = new Set()) {
  if (!node || typeof node !== 'object') return node;
  if (node.$ref) {
    if (seen.has(node.$ref)) return node;
    seen.add(node.$ref);
    const target = resolveRef(node.$ref, common);
    return target ? deref(target, common, seen) : node;
  }
  return node;
}

/**
 * True when the schema resolves its component TYPE (or the whole component item) through
 * a `$ref` into the common schema — so a missing/unresolvable common schema must STOP
 * authoring rather than being ignored. Detects both forms:
 *   components.items.properties.type.$ref → common…
 *   components.items.$ref → common…/component
 */
export function schemaNeedsCommon(primarySchema) {
  try {
    const comps = primarySchema && primarySchema.properties && primarySchema.properties.components;
    if (!comps || !comps.items) return false;
    const itemsRef = comps.items.$ref;
    if (typeof itemsRef === 'string' && /common\.(?:schema\.)?json/.test(itemsRef)) return true;
    const type = comps.items.properties && comps.items.properties.type;
    if (type && typeof type.$ref === 'string' && /common\.(?:schema\.)?json/.test(type.$ref)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Extract the allowed componentType enum an architecture schema implies, or null. */
export function extractAllowedComponentTypes(primarySchema, commonSchema) {
  try {
    const comps = primarySchema && primarySchema.properties && primarySchema.properties.components;
    if (!comps || !comps.items) return null;
    // Dereference the ITEM first: a real schema often points `components.items` at
    // `common.$defs.component`, whose own `properties.type` is a FURTHER `$ref` into
    // the common schema. Handling only the direct `items.properties.type.$ref` form
    // missed that two-level shape.
    const itemNode = deref(comps.items, commonSchema);
    const typeNode = deref(itemNode && itemNode.properties && itemNode.properties.type, commonSchema);
    if (typeNode && Array.isArray(typeNode.enum) && typeNode.enum.length) {
      return typeNode.enum;
    }
    // Fall back: inline (test) schemas that declare an enum directly on
    // `components.items.properties.type`.
    const inlineEnum = comps.items.properties && comps.items.properties.type && comps.items.properties.type.enum;
    if (Array.isArray(inlineEnum) && inlineEnum.length) return inlineEnum;
    // Fall back: the dereferenced item node's own inline enum (on the $defs target).
    const inlineItemEnum = itemNode && itemNode.properties && itemNode.properties.type && itemNode.properties.type.enum;
    if (Array.isArray(inlineItemEnum) && inlineItemEnum.length) return inlineItemEnum;
    return null;
  } catch {
    return null;
  }
}

/** True when a candidate's inferred type is not in the allowed set. */
export function isTypeAllowed(type, allowedTypes) {
  if (!allowedTypes || !allowedTypes.length) return true;
  return allowedTypes.includes(type);
}

/**
 * Snap an inferred type to the nearest allowed type rather than silently dropping
 * the module. Priority: (1) the inferred type if allowed, (2) `external` if allowed,
 * (3) the first allowed type, (4) null (caller decides). Returning null here means
 * the builder should keep the module but flag a type conflict rather than erase it.
 */
export function snapType(inferred, allowedTypes) {
  if (!allowedTypes || !allowedTypes.length) return inferred;
  if (allowedTypes.includes(inferred)) return inferred;
  if (allowedTypes.includes('external')) return 'external';
  // Best-effort: the first allowed type (deterministic) — keeps the module visible.
  return allowedTypes[0] || null;
}
