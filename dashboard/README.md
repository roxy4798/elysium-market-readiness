# Elysium Market Readiness Dashboard

The dashboard is a TypeScript client for the Phase 4A REST API. It displays persisted indexer results and does not calculate assessment scores.

## Run locally

1. Start PostgreSQL and the indexer API using the existing project setup. From `indexer`, run `npm run serve` (the API defaults to `http://localhost:3000`).
2. From `dashboard`, run `npm install` once, then `npm run dev`.
3. Open `http://localhost:5173`.

The API base URL is configured by the `elysium-api-base` meta tag in `index.html`. Keep production API configuration deployment-specific; do not put credentials in the frontend.

## Quality commands

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run preview` (serves the production build on port 4173)

The current indexed dataset may contain insufficient historical observations. The UI preserves null scores and reports the API's insufficient-data state without synthesizing history.
