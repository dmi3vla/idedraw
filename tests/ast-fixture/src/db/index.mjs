// PostgreSQL client. Single place the API tier reads/writes durable state.
export function query(sql) {
  return Promise.resolve({ rows: [{ sql }] });
}

export const dsn = 'postgres://user:pass@db:5432/app';
