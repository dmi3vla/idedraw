import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveRef,
  deref,
  extractAllowedComponentTypes,
  schemaNeedsCommon,
  snapType,
  isTypeAllowed,
} from '../main/schema-resolver.mjs';

// The real Archify schema graph: `architecture.schema.json` points
// `components.items.properties.type` at `common.schema.json#/$defs/componentType`.
// We copy minimal fragments rather than re-download (the sandbox has no DNS).
// The tests cover the TWO reference shapes the resolver supports — a direct type
// `$ref` and an `items.$ref -> component` indirection. It is not a general JSON
// Schema resolver, so upstream could diverge; these pinned fragments document the
// supported shapes rather than claiming to freeze the entire upstream schema.

const commonComponentTypes = ['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external'];

function commonSchema() {
  return {
    $defs: {
      id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' },
      componentType: { enum: commonComponentTypes }, // closed enum
      component: { type: 'object', properties: { type: { $ref: 'common.schema.json#/$defs/componentType' } } },
    },
  };
}

test('resolveRef resolves a local $defs pointer into the common schema', () => {
  const common = commonSchema();
  const node = resolveRef('common.schema.json#/$defs/componentType', common);
  assert.deepEqual(node, { enum: commonComponentTypes });
});

test('resolveRef returns null for a missing pointer / malformed reference', () => {
  const common = commonSchema();
  assert.equal(resolveRef('common.schema.json#/nope', common), null);
  assert.equal(resolveRef('common.schema.json#/$defs/componentType/extra', common), null); // pointer walks past the enum
  assert.equal(resolveRef('other.json#/$defs/componentType', common), null); // not common
  assert.equal(resolveRef(null, common), null);
});

test('deref climbs an immediate $ref chain to the concrete node', () => {
  const common = commonSchema();
  // $defs.component itself has no top-level $ref, so deref returns it directly.
  const node = deref({ $ref: 'common.schema.json#/$defs/component' }, common);
  assert.equal(node.type, 'object');
});

test('deref guards against a cyclic $ref (returns the node, does not recurse forever)', () => {
  const a = { $ref: 'common.schema.json#/$defs/a' };
  const cyclic = { $defs: { a: { $ref: 'common.schema.json#/$defs/a' } } };
  const node = deref(a, cyclic);
  // A cycle cannot resolve to a concrete enum; it should not throw and should settle.
  assert.ok(node);
});

test('extractAllowedComponentTypes handles the DIRECT type $ref (real Archify form)', () => {
  const primary = {
    type: 'object',
    properties: { components: { type: 'array', items: { type: 'object', properties: { type: { $ref: 'common.schema.json#/$defs/componentType' } } } } },
  };
  const common = commonSchema();
  assert.deepEqual(extractAllowedComponentTypes(primary, common), commonComponentTypes);
});

test('extractAllowedComponentTypes handles the NESTED items.$ref -> component -> type.$ref form', () => {
  const primary = {
    type: 'object',
    properties: { components: { type: 'array', items: { $ref: 'common.schema.json#/$defs/component' } } },
  };
  const common = commonSchema();
  assert.deepEqual(extractAllowedComponentTypes(primary, common), commonComponentTypes);
});

test('extractAllowedComponentTypes falls back to an inline enum (test schemas)', () => {
  const primary = {
    type: 'object',
    properties: { components: { type: 'array', items: { type: 'object', properties: { type: { enum: ['frontend', 'backend'] } } } } },
  };
  assert.deepEqual(extractAllowedComponentTypes(primary, null), ['frontend', 'backend']);
});

test('extractAllowedComponentTypes returns null when the common ref cannot be resolved', () => {
  const primary = {
    type: 'object',
    properties: { components: { type: 'array', items: { type: 'object', properties: { type: { $ref: 'common.schema.json#/$defs/componentType' } } } } },
  };
  assert.equal(extractAllowedComponentTypes(primary, { $defs: {} }), null);
  assert.equal(extractAllowedComponentTypes(primary, null), null);
});

test('extractAllowedComponentTypes returns null for a malformed/garbage schema', () => {
  assert.equal(extractAllowedComponentTypes({ nonsense: true }, null), null);
  assert.equal(extractAllowedComponentTypes({ type: 'array' }, null), null);
  assert.equal(extractAllowedComponentTypes(null, null), null);
});

test('schemaNeedsCommon is true when the type resolves via an common $ref, false for inline enum', () => {
  const typeRef = { type: 'object', properties: { components: { type: 'array', items: { type: 'object', properties: { type: { $ref: 'common.schema.json#/$defs/componentType' } } } } } };
  const itemRef = { type: 'object', properties: { components: { type: 'array', items: { $ref: 'common.schema.json#/$defs/component' } } } };
  const inline = { type: 'object', properties: { components: { type: 'array', items: { type: 'object', properties: { type: { enum: ['frontend'] } } } } } };
  assert.equal(schemaNeedsCommon(typeRef), true);
  assert.equal(schemaNeedsCommon(itemRef), true);
  assert.equal(schemaNeedsCommon(inline), false);
});

test('isTypeAllowed returns true for no enum, false for a disallowed type', () => {
  assert.equal(isTypeAllowed('database', null), true);
  assert.equal(isTypeAllowed('database', ['frontend', 'backend']), false);
  assert.equal(isTypeAllowed('backend', ['frontend', 'backend']), true);
});

test('snapType is deterministic and never silently drops (returns a usable allowed type)', () => {
  // disallowed -> external if allowed, else first allowed, else the type is kept via null (caller warns)
  assert.equal(snapType('database', ['frontend', 'backend']), 'frontend');
  assert.equal(snapType('database', ['external', 'backend']), 'external');
  assert.equal(snapType('database', ['backend']), 'backend');
  assert.equal(snapType('database', null), 'database'); // no enum -> untouched
});
