// Client-side SPA. Rendered in the browser and talks to the HTTP API tier.
import { apiBase } from '../api/server.mjs';

export const origin = 'https://app.example.dev';

export function boot() {
  // eslint-disable-next-line no-console
  console.log('spa boot @', apiBase);
}
