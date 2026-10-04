# Elysium Market Readiness Dashboard

The dashboard is a TypeScript client for the Phase 4A REST API. It displays persisted indexer results and does not calculate assessment scores.

## Run locally

1. Start PostgreSQL and the indexer API using the existing project setup. From `indexer`, run `npm run serve` (the API defaults to `http://localhost:3000`).
2. From `dashboard`, run `npm install` once, then `npm run dev`.
3. Open `http://localhost:5173`.

The development default is `http://localhost:3000`. Production builds can inject a public API URL with `API_BASE_URL=https://api.example.com npm run build`; the build embeds it in the generated `dist/index.html`. The value is public frontend configuration only, so never put credentials or secrets in it.

## Quality commands

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run preview` (serves the production build on port 4173)

The current indexed dataset may contain insufficient historical observations. The UI preserves null scores and reports the API's insufficient-data state without synthesizing history.
