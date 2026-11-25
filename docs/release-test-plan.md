# Replicator 4.0.0: release plan and test results

Baseline: **replicator 3.8.1** (jinaga 6.15.0, jinaga-server 3.8.1), published 2026-11-01.

Target: **replicator 4.0.0**, with jinaga 6.17.0 and jinaga-server 3.9.0 (published 2026-11-25).

## Decisions

- `setup.sql` runs automatically on every start (`start.sh`). It is idempotent. Skip it with `JINAGA_SKIP_DATABASE_SETUP=true`.
- `repair-edge-order.sql` is manual. The procedure is in README § "Repair the edge order".
- Version 4.0.0. Policy and subscription files that 3.8.1 loaded can fail to load.
- `JINAGA_MAX_SAVE_LINE_BYTES` defaults to 1 MiB. The reasoning is in `saveLineLimit.ts` and the README.
- No keystore image release is needed. Because `start.sh` applies `setup.sql`, a fresh database also gets the constraint, and Phase C verifies it.

## Changes in this branch (`release/4.0.0`, uncommitted)

| File | Change |
|---|---|
| `start.sh` | Starts PostgreSQL and the replicator. Applies `setup.sql` once PostgreSQL answers on TCP, then writes a marker. Traps SIGTERM and SIGINT: the replicator stops first, then PostgreSQL with a fast shutdown. If either process exits, the container exits. |
| `databaseSetup.ts`, `index.ts`, `health.ts` | Initialization waits for the marker before opening the fact store. `/ready` reports `database setup` meanwhile. |
| `saveLineLimit.ts`, `index.ts` | `JINAGA_MAX_SAVE_LINE_BYTES` sets `maxSaveLineBytes`. An invalid value fails initialization. |
| `telemetry/trace.ts` | `metric` creates one gauge per key instead of one instrument per call, which leaked. The message is recorded as an attribute; feed usage is split into `shape` and `instance`. |
| `package.json` | `jinaga ^6.17.0`, `jinaga-server ^3.9.0` |
| `README.md`, `CLAUDE.md` | Upgrade guide, repair and rollback procedures, new variables, shutdown, the `database setup` reason, pull-only replication. |
| `test/upgrade/` | Docker harness: `build-rc.sh`, `run.sh`, fixtures and probes. |

## Results (RC built from the published jinaga 6.17.0 and jinaga-server 3.9.0, arm64, 2026-11-25)

`test/upgrade/run.sh`: **all checks passed.**

| Area | 3.8.1 | 4.0 RC |
|---|---|---|
| Upgrade of a 3.8.1 data folder (420 facts, 110 inverted edges) | n/a | setup applied; constraint added NOT VALID; facts, edges and feeds unchanged; repair warning logged |
| Repair (documented procedure) | n/a | 0 inversions; validated; every fact and predecessor kept by hash; feeds unchanged; resumed readers miss nothing (moved facts delivered again) |
| Fresh install | n/a | constraint validated from the start; no warning |
| Failed or skipped setup | n/a | replicator starts and logs why |
| `docker stop` | exit 137, PostgreSQL recovers WAL on next start | exit 0, clean shutdown |
| Roll back to 3.8.1 | serves reads and client saves; **500 on successor-first saves** until the constraint is dropped | n/a |
| F1 disconnected `/read` | 200 `[]` | 400 naming both subgraphs |
| F3 product feeds (J!, B) | 200 | 400 |
| F4 disconnected/product policy, disconnected subscription | loads | **initialization failed** |
| F5 batch authorization | 403 | 201; the unauthorized control is still 403 |
| F6/F7 share rules (positive inside negative, repeated label) | policy fails to load | load and serve |
| F8 downstream subscription, restore through two cancellers | downstream receives nothing | matches upstream |
| F12 unknown feed decision from upstream | subscription stops without reading the feed (an error was logged within 5 s in one run of two) | continues, no error |
| F13 save line limit | none | 413 over 1 MiB; configurable; invalid value refused |
| F17 given-only `/read` | `[]` | the given |
| F18 identity between bound labels | `[]` even for the matching office | correct rows |
| Metrics | one instrument per call | one per key, with attributes |

### An application stack, upgraded in place (amd64)

A Docker Compose application stack ran 3.8.1 with its own policies and three authentication providers. Its data folder (10,168 facts, 17,057 edges, 250,857 ancestors) was backed up, then upgraded in place with the amd64 RC.

- The policy loaded under 4.0. PostgreSQL recovered from the last unclean 3.8.1 stop, the setup ran, and the replicator was ready in 3 s.
- The data held no inverted edges, so the constraint was validated at once and no repair was needed. On a copy, the repair took 2 s and moved nothing.
- The largest fact's fields were 501 bytes, well under the 1 MiB limit.
- Every service in the stack became healthy against the 4.0 replicator: an identity provider that logs in and saves, a mirror worker that subscribes to 13 feeds and exits on a denial, and the browser apps behind nginx. The stack then stopped cleanly with exit 0.
- The data folder was then restored from the backup.

### Findings

- **Push upstream is not implemented** in either version. jinaga-server's `PostgresQueue` stores nothing, so facts saved to a replicator never reach its upstream. Replication is pull-only, through subscriptions; the README now says so. As a result, jinaga's saver changes (#398, #415, #418) have no path to run in a replicator.
- **Every 3.8.1 container stop is a SIGKILL** (exit 137). The data folder has always recovered, but upgrading means one more unclean stop.

### Not covered by the harness

- Concurrent save throughput under the new save lock (jinaga-server #244, #253).
- Feed read coalescing (#249).
- Deep-page latency with and without pruning (#248, #259).
- `LOG_LEVEL` governing stream log lines (#242).
- Read snapshots (#228).

jinaga-server's own tests cover these (38 suites pass on main). Its integration suite runs on PostgreSQL 17, while the image runs 14.

- **Repair duration at scale.** 420 facts took under a second. Measure on a copy of a production data folder before scheduling the repair, as the README describes.

## Remaining release steps

1. ~~Release jinaga-server~~: 3.9.0 published to npm with `scripts/release.sh minor`.
2. ~~Switch the replicator to `jinaga-server ^3.9.0`, build the RC from npm, rerun the harness~~: all checks passed. Run it on amd64 as well if you can.
3. ~~Validate an application's `.policy` files with the RC~~: the in-place stack test above. Do the same for each other deployment before it upgrades.
4. Commit, open a PR, and merge. Then `npm version major` and `git push --follow-tags`; CI publishes `4.0.0`, `4.0`, `latest` and the no-security image.
5. Pull the published image for each architecture and run `IMAGE_NEW=jinaga/jinaga-replicator:4.0.0 test/upgrade/run.sh upgrade fresh`.
