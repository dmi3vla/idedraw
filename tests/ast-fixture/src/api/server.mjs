// HTTP API tier. Listens on :8080, serves JSON, reads/writes through the DB and
// forwards structured logs through the log transport.
import { query, dsn } from '../db/index.mjs';
import { log } from '../log/index.mjs';

export const port = 8080;
export const apiBase = `http://localhost:${port}`;

export async function handle(req) {
  const rows = await query('select 1');
  log('info', { port, dsn });
  return { port, rows, dsn };
}
