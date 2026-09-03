import * as esbuild from 'esbuild';
import { mkdirSync, cpSync } from 'node:fs';

mkdirSync('src/dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/renderer-entry.jsx'],
  bundle: true,
  format: 'esm',
  outfile: 'src/dist/renderer.bundle.js',
  jsx: 'automatic',
  loader: { '.jsx': 'jsx' },
  platform: 'browser',
  logLevel: 'info',
});

// @excalidraw/excalidraw ships its own CSS import; esbuild's `bundle` for JS
// entry points doesn't auto-emit the CSS side effect as a file we can link,
// so pull it in explicitly.
cpSync(
  'node_modules/@excalidraw/excalidraw/dist/prod/index.css',
  'src/dist/excalidraw.css'
);

// The Excalidraw CSS references its bundled fonts via relative urls
// (e.g. url("./fonts/Assistant/Assistant-Regular.woff2")). Without copying
// them next to the css, the renderer logs ERR_FILE_NOT_FOUND 404s and falls
// back to system fonts. Mirror the package's `fonts` tree into src/dist/fonts.
cpSync(
  'node_modules/@excalidraw/excalidraw/dist/prod/fonts',
  'src/dist/fonts',
  { recursive: true }
);

console.log('Build complete: src/dist/renderer.bundle.js');
