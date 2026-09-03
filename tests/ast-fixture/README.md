# AST Fixture

A four-tier fixture used by the S6 AST-anchor live proof
(`--scenario=archify-ast-anchor`). It deliberately extends the canonical
`fixture-project` (web -> api -> db) with a `log` tier so the AST-anchor manifest
has a second-order dependency with a `via` hop (`web` -> `api` -> `log`).

Unlike the canonical `fixture-project`, this directory is used ONLY by the AST
anchor acceptance; the `archify-agent` scenario stays on the untouched 3-node
fixture so its independent `web/api/db` expectation never drifts.

## Stack

- `src/web/app.mjs` — client-side SPA; imports the HTTP API tier.
- `src/api/server.mjs` — HTTP API server; imports the DB and the log transport.
- `src/db/index.mjs` — PostgreSQL client used by the API tier.
- `src/log/index.mjs` — structured log transport used by the API tier.
