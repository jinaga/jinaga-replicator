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
5. Start Express on `PORT` (default 8080), mounting `JinagaServer` (from `jinaga-server`). `/jinaga` is mounted before initialization runs, behind a gate that answers 503 (never 404) until the handler chain is ready
6. Load subscriptions from `JINAGA_SUBSCRIPTIONS` directory and connect to upstream replicators discovered from `REPLICATOR_UPSTREAM_N` env vars
7. Register graceful shutdown on SIGINT/SIGTERM

### Key modules

- **`authenticate.ts`** — Builds a JWT authentication function for `JinagaServer`. Reads `.provider` files (one per provider); each file matches on `iss`/`aud` and resolves the signing key either from a static `key`/`key_id` (RSA PEM or symmetric secret) or dynamically from a `jwks_uri` endpoint by the token's `kid` (with caching and cache-miss refetch via `jwks-rsa`, supporting RS256 key rotation). Verification is async (awaited) and constrained by an explicit algorithm allowlist (RS256 for asymmetric/JWKS keys, HMAC family for symmetric keys). A JWKS lookup is classified: only jwks-rsa's `SigningKeyNotFoundError` (the endpoint answered, and does not publish that `kid`) is a 401; an unreachable endpoint, non-2xx response, timeout, or rate-limit yields 503 `Authentication provider unavailable` with `Retry-After`, so a valid token during an outage is not reported as a bad token. Every failure response is sent as `text/plain` with `X-Content-Type-Options: nosniff` via `sendAuthenticationError`, since `res.send` of a string otherwise makes Express label a diagnostic as `text/html`. The request user's `profile.displayName` is taken from the first of the OIDC §5.1 `name`, `preferred_username`, or the legacy non-standard `display_name` claims that carries a non-blank string — claims are type-checked rather than coalesced, since `jinaga-server` passes the value to the client as a required string without examining it. Supports anonymous access if `allow-anonymous` marker file is present.

- **`loadPolicies.ts`** — Reads `.policy` files containing Jinaga authorization, distribution, and purge rules. Merges them into a single `RuleSet` for `JinagaServer`. Security is bypassed entirely if `no-security-policies` marker file is present.

- **`policyReloader.ts`** — Optional (`JINAGA_POLICIES_WATCH=true`) lazy hot-reload of policies. Rather than a background filesystem watcher, it exposes a cheap `checkForChanges()` that the `/jinaga` wrapper calls per request: it fingerprints the `.policy` files and the `no-security-policies` marker by size + mtime (via `stat`, so it works over network mounts like SMB/NFS where inotify events are not delivered, with no idle poll loop) and, when the fingerprint changes, triggers a background reload. The reload re-runs `loadPolicies`, rebuilds a `JinagaServer` instance from the new rules, re-attaches subscriptions, and atomically swaps the instance delegated to from `/jinaga` (in-flight requests finish against the old instance, whose subscriptions are stopped and pools closed after a grace period). A parse failure keeps the current rules and logs a warning rather than crashing.

- **`subscriptions.ts`** — Reads `.subscription` files (Jinaga specification syntax), starts observers against upstream replicators to pull matching facts into the local store. An upstream rejection is classified from the `HttpError` that jinaga's web client now throws: a retryable status (5xx/408/429) logs a warning, while any other 4xx logs an error naming the status and the upstream's reason, since jinaga no longer retries those and the subscription stays stalled until the cause is fixed.

- **`findUpstreamReplicators.ts`** — Discovers upstream replicator URLs from `REPLICATOR_UPSTREAM_1`, `REPLICATOR_UPSTREAM_2`, … env vars.

- **`health.ts`** — Provides unauthenticated `/health` (liveness) and `/ready` (readiness) endpoints. Liveness always returns 200 and performs no dependency checks (so a database outage can't trigger a container restart). Readiness returns 503 until initialization completes, then verifies PostgreSQL connectivity (`SELECT 1` via a dedicated single-connection pool) on each probe. The not-ready `reason` separates `initializing` from `initialization failed` (recorded by `setInitializationFailed` when the startup catch in `index.ts` fires, since nothing retries) and `database unavailable`. Both are registered before async initialization so they respond throughout startup; `notReadyReason()` is shared with the `/jinaga` gate so a request to a real route gets the same diagnosis as a probe. The Dockerfile's `HEALTHCHECK` probes `/health`.

- **`telemetry/`** — OpenTelemetry SDK setup. Activates gRPC OTLP exporters when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; falls back to console output otherwise.

### Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 8080) |
| `JINAGA_POSTGRESQL` | PostgreSQL connection string |
| `JINAGA_POLICIES` | Path to directory of `.policy` files |
| `JINAGA_POLICIES_WATCH` | Set to `true` to hot-reload `.policy` files without a restart, via a per-request `stat`-based staleness check (default off) |
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
