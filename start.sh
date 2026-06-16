#!/bin/bash
set -e

if [ -z "$JINAGA_POSTGRESQL" ]; then
  # Internal PostgreSQL mode: generate and persist credentials
  CREDS_FILE="$PGDATA/.replicator-creds"

  if [ ! -f "$CREDS_FILE" ]; then
    mkdir -p "$PGDATA"
    printf "POSTGRES_PASSWORD=%s\nAPP_PASSWORD=%s\n" \
      "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" \
      "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" \
      > "$CREDS_FILE"
    chmod 600 "$CREDS_FILE"
  fi

  # shellcheck source=/dev/null
  . "$CREDS_FILE"
  export POSTGRES_PASSWORD APP_PASSWORD

  export JINAGA_POSTGRESQL="postgresql://${APP_USERNAME}:${APP_PASSWORD}@localhost:5432/${APP_DATABASE}"

  cd /replicator
  npm start & exec /usr/local/bin/docker-entrypoint.sh postgres
else
  # External PostgreSQL mode: skip internal postgres entirely
  cd /replicator
  exec npm start
fi
