// Structured log transport. The API tier forwards request/diagnostic events here
// without coupling to the HTTP or DB layers.
export function log(level, payload) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(level, payload));
  return payload;
}

export const transport = 'structured';
