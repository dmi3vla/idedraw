// Общая фикстура (рефакторинг R5): один и тот же tierFiles был скопирован в
// tests/ast-anchor-manifest.test.mjs и tests/ast-anchor-preview.test.mjs.
export const TIER_FILES = Object.freeze({
  web: ['src/web/app.ts'],
  api: ['src/api/index.ts', 'src/api/routes.ts'],
  db: ['src/db/index.ts'],
  log: ['src/log/index.ts'],
});
