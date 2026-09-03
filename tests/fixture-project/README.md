# Fixture App

A tiny three-tier application used by the model-driven authoring acceptance
scenario (`--scenario=archify-agent`). The agent reads these files as evidence
and authors an Archify `architecture` candidate that maps the code onto the
canvas: `web -> api -> db`.

## Stack

- `src/web/app.mjs` — client-side SPA served to the browser.
- `src/api/server.mjs` — HTTP API server on port 8080.
- `src/db/index.mjs` — PostgreSQL client used by the API tier.
