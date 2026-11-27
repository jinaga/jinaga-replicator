# Upgrade and feature harness

Tests a replicator release candidate in Docker: an in-place upgrade of a data folder written by the previous release, a fresh install, a rollback, and the features and fixes the release brings. It needs Docker and Node 18 or later, and runs from the repository with its dependencies installed (`npm ci`).

```bash
# Build a candidate from the working tree (add tarballs from `npm pack` in
# jinaga-server or jinaga.js to test against unpublished packages).
test/upgrade/build-rc.sh [path/to/package.tgz ...]

# Run every section, or name the ones to run.
test/upgrade/run.sh [upgrade] [fresh] [rollback] [probes] [mesh] [metrics]
```

| Variable | Default | |
|---|---|---|
| `IMAGE_OLD` | 3.8.1, by its index digest | the release being upgraded from. Pinned by digest so that pulling it for `PLATFORM` never moves a local `3.8.1` tag that another stack runs |
| `IMAGE_NEW` | `jinaga-replicator:rc` | the candidate |
| `PLATFORM` | the host's architecture | a PostgreSQL data folder is not portable between architectures, so both images run on the same one |
| `WORK` | `test/upgrade/.work` | data folders and snapshots |

Containers are named `jr-*` and use ports 18080–18095.

## Sections

- **upgrade.** Seeds a data folder on `IMAGE_OLD`, with half the batches saved successor-first so that it holds out-of-order edges, and records every fact, edge and feed by hash. It then starts `IMAGE_NEW` on the same folder, and checks:
  - the schema is upgraded and nothing changes;
  - `repair-edge-order.sql`, run as the README documents, keeps every fact and predecessor;
  - a reader resuming from a bookmark taken before the repair misses nothing;
  - the container stops cleanly.
- **fresh.** A new data folder gets the constraint in force. `JINAGA_SKIP_DATABASE_SETUP` skips the setup, and a failed setup still lets the replicator start.
- **rollback.** `IMAGE_OLD` on the upgraded folder: reads, client saves, and dropping the constraint.
- **probes.** HTTP probes (`probes.mjs`) against each image, using the fixtures in `fixtures/`. They cover refused specifications, specification shapes, the save line limit, batch authorization, the repaired share rules, and a share rule whose condition joins only a given (`given-only`). Against `IMAGE_OLD` they print `INFO` lines, so the output shows what changed.
- **mesh.** A downstream replicator subscribing to an upstream one, a subscription whose condition joins only its given (`given-only`), an upstream stub (`stub.mjs`) that reports a feed decision this client does not know, and whether saved facts are pushed upstream.
- **metrics.** `OpenTelemetryTracer.metric` against an in-memory exporter.
