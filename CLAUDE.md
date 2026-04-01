# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build        # TypeScript compilation → dist/

# Development (auto-recompile on .ts changes, uses devenv/ config + local PostgreSQL)
npm run dev

# Start (requires a prior build)
npm start
```

There are no automated tests (`npm test` is a placeholder). Manual API tests live in `http/` and can be run with the HttpYac VS Code extension.

## Architecture

The Jinaga Replicator is a **fact storage and distribution node** in a Jinaga mesh network. It wraps `jinaga-server` (which handles the core fact store and WebSocket sync) with authentication, policy enforcement, upstream replication, and observability.

### Startup flow (`index.ts`)

1. Initialize OpenTelemetry (`telemetry/`) before any other imports
2. Load JWT authentication providers from `JINAGA_AUTHENTICATION` directory
3. Load security policies from `JINAGA_POLICIES` directory
4. Connect to PostgreSQL via `JINAGA_POSTGRESQL`
5. Start Express on `PORT` (default 8080), mounting `JinagaServer` (from `jinaga-server`)
6. Load subscriptions from `JINAGA_SUBSCRIPTIONS` directory and connect to upstream replicators discovered from `REPLICATOR_UPSTREAM_N` env vars
7. Register graceful shutdown on SIGINT/SIGTERM

### Key modules

- **`authenticate.ts`** — Builds a JWT authentication function for `JinagaServer`. Reads `.authentication` files (one per provider); each file contains a public key (RSA/symmetric) plus optional `iss`/`aud` constraints. Supports anonymous access if `allow-anonymous` marker file is present.

- **`loadPolicies.ts`** — Reads `.policy` files containing Jinaga authorization, distribution, and purge rules. Merges them into a single `RuleSet` for `JinagaServer`. Security is bypassed entirely if `no-security-policies` marker file is present.

- **`subscriptions.ts`** — Reads `.subscription` files (Jinaga specification syntax), starts observers against upstream replicators to pull matching facts into the local store.

- **`findUpstreamReplicators.ts`** — Discovers upstream replicator URLs from `REPLICATOR_UPSTREAM_1`, `REPLICATOR_UPSTREAM_2`, … env vars.

- **`telemetry/`** — OpenTelemetry SDK setup. Activates gRPC OTLP exporters when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; falls back to console output otherwise.

### Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 8080) |
| `JINAGA_POSTGRESQL` | PostgreSQL connection string |
| `JINAGA_POLICIES` | Path to directory of `.policy` files |
| `JINAGA_AUTHENTICATION` | Path to directory of `.authentication` files |
| `JINAGA_SUBSCRIPTIONS` | Path to directory of `.subscription` files |
| `REPLICATOR_UPSTREAM_N` | Numbered upstream replicator URLs (HTTP/HTTPS) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector gRPC endpoint |
| `OTEL_SERVICE_NAME` | Service name for telemetry (default: `jinaga-replicator`) |

### Local development

`devenv/` contains sample policies, authentication, and subscription files used by `npm run dev`. The dev script connects to a local PostgreSQL at `postgresql://appuser:apppw@localhost:5432/appdb`.

`mesh/` contains a Docker Compose setup for running a multi-node local mesh.

### Deployment

Docker images are built and published via `.github/workflows/docker-image.yml`. The image is Alpine-based with a multi-stage build; configuration directories are mounted as volumes at runtime.
