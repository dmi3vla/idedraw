// The app root. Scenario files live one level deeper than main.mjs, so what
// used to be __dirname resolves through here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
