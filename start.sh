#!/bin/bash
#
# The image runs two processes: PostgreSQL, through the official postgres
# image's entrypoint, and the replicator. This script starts both, upgrades the
# database schema, and stops both cleanly when the container is stopped.
#
# Schema upgrade. The postgres entrypoint runs /docker-entrypoint-initdb.d only
# when the data folder is empty, so a data folder written by an earlier
# replicator never receives a later schema on its own. Once PostgreSQL is up,
# this script applies jinaga-server's setup.sql, which is idempotent: every
# change in it is guarded, and a database already up to date is left as it is.
# The replicator starts at the same time, so /health and /ready answer
# throughout, but it waits for the marker file before it opens the fact store.
# Set JINAGA_SKIP_DATABASE_SETUP=true to skip the upgrade.
#
# Signals. Docker sends SIGTERM to PID 1, which is this script. Without the
# trap below bash ignores it, and both processes are killed when the stop
# timeout expires. Instead the replicator is stopped first, so that it stops
# taking requests, and then PostgreSQL with a fast shutdown.

set -u

setup_sql=/replicator/node_modules/jinaga-server/setup.sql
export JINAGA_DATABASE_SETUP_MARKER=/tmp/jinaga-database-setup

# A restarted container keeps its filesystem, so clear the previous run's
# outcome before the replicator can read it.
rm -f "$JINAGA_DATABASE_SETUP_MARKER"

/usr/local/bin/docker-entrypoint.sh postgres &
postgres_pid=$!

cd /replicator
node dist &
replicator_pid=$!

setup_database() {
  local outcome=complete
  if [ "${JINAGA_SKIP_DATABASE_SETUP:-}" = "true" ]; then
    echo "Database setup: skipped, because JINAGA_SKIP_DATABASE_SETUP is true."
    outcome=skipped
  else
    # The entrypoint first runs a temporary server to initialize an empty data
    # folder, and that server listens on no TCP address. Waiting on TCP, rather
    # than on the socket, therefore waits for the server that stays up.
    until pg_isready -q -h 127.0.0.1 -p "${PGPORT:-5432}" -U "${POSTGRES_USER:-postgres}"; do
      if ! kill -0 "$postgres_pid" 2>/dev/null; then
        return
      fi
      sleep 1
    done
    echo "Database setup: applying $setup_sql to $APP_DATABASE."
    # Notices report each guarded step that had nothing to do, such as an
    # extension that already exists, which on every start is noise.
    if PGOPTIONS="-c client_min_messages=warning" psql -v ON_ERROR_STOP=1 -q -X \
        -U "${POSTGRES_USER:-postgres}" -d "$APP_DATABASE" -f "$setup_sql"; then
      echo "Database setup: complete."
    else
      echo "Database setup: FAILED. The replicator will start with the schema as it is." >&2
      outcome=failed
    fi
  fi
  # Write the marker in one step, so the replicator never reads half of it.
  echo "$outcome" > "$JINAGA_DATABASE_SETUP_MARKER.tmp"
  mv "$JINAGA_DATABASE_SETUP_MARKER.tmp" "$JINAGA_DATABASE_SETUP_MARKER"
}

setup_database &

stop_all() {
  trap - TERM INT
  kill -TERM "$replicator_pid" 2>/dev/null
  wait "$replicator_pid" 2>/dev/null
  # SIGINT is PostgreSQL's fast shutdown: it disconnects any clients and
  # checkpoints, without waiting for sessions to end on their own.
  kill -INT "$postgres_pid" 2>/dev/null
  wait "$postgres_pid" 2>/dev/null
}

trap 'stop_all; exit 0' TERM INT

# If either process exits on its own, stop the other and exit with its status,
# so the container's restart policy can act instead of leaving half a
# replicator running.
wait -n "$postgres_pid" "$replicator_pid"
status=$?
echo "A replicator process exited with status $status; stopping the container." >&2
stop_all
exit "$status"
