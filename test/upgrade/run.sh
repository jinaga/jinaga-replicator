#!/bin/bash
# Upgrade and feature harness for a replicator release.
#
#   test/upgrade/run.sh [upgrade] [fresh] [rollback] [probes] [mesh] [metrics]
#
# With no arguments every section runs. IMAGE_OLD is the release being upgraded
# from (default jinaga/jinaga-replicator:3.8.1) and IMAGE_NEW the candidate
# (default jinaga-replicator:rc, from build-rc.sh). Both run for PLATFORM, the
# host's own architecture by default, because a PostgreSQL data folder is not
# portable between architectures. Work files go to WORK (test/upgrade/.work).
set -uo pipefail
cd "$(dirname "$0")"
source ./common.sh

sections=("$@")
[ ${#sections[@]} -eq 0 ] && sections=(upgrade fresh rollback probes mesh metrics)
failures=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; failures=$((failures + 1)); }
expect() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
heading() { echo; echo "=== $*"; }

inversions() { psql_in "$1" "select count(*) from edge where successor_fact_id < predecessor_fact_id"; }
validated() { psql_in "$1" "select coalesce((select convalidated::text from pg_constraint where conname = 'ck_edge_successor_after_predecessor' and conrelid = 'public.edge'::regclass), 'absent')"; }
# Facts by identity rather than id, since the repair moves ids.
snapshot() {
  psql_in "$1" "select t.name || ' ' || f.hash || ' ' || coalesce(f.data::text, '') from fact f join fact_type t on t.fact_type_id = f.fact_type_id order by 1"
}
# Each fact's predecessors by hash and role, so a repair that rewired an edge shows.
edges() {
  psql_in "$1" "select ts.name || ':' || s.hash || ' ' || r.name || ' ' || tp.name || ':' || p.hash from edge e join fact s on s.fact_id = e.successor_fact_id join fact p on p.fact_id = e.predecessor_fact_id join fact_type ts on ts.fact_type_id = s.fact_type_id join fact_type tp on tp.fact_type_id = p.fact_type_id join role r on r.role_id = e.role_id order by 1"
}
# The log of the container's most recent start only.
since_last_start() {
  docker logs "$1" 2>&1 | awk '/Database setup: (complete|skipped|FAILED)/ { buffer = "" } { buffer = buffer $0 "\n" } END { printf "%s", buffer }'
}
export -f since_last_start
feeds_of() { node seed.mjs feeds "http://localhost:$1/jinaga"; }

upgrade() {
  heading "Phase A: seed a data folder on $IMAGE_OLD"
  rm -rf "$WORK/data" "$WORK/golden" && mkdir -p "$WORK"
  start jr-subject "$IMAGE_OLD" open 18080 "$WORK/data" || { fail "3.8.1 subject started"; return; }
  wait_ready 18080 >/dev/null || { fail "3.8.1 subject started"; return; }
  node seed.mjs seed http://localhost:18080/jinaga || fail "seeding"
  local before; before=$(inversions jr-subject)
  expect "3.8.1 wrote inverted edges for successor-first saves ($before)" test "$before" -gt 0
  snapshot jr-subject > "$WORK/facts.before"
  edges jr-subject > "$WORK/edges.before"
  feeds_of 18080 > "$WORK/feeds.before"
  # Every comparison below is against these, so an empty baseline would let
  # them all pass without comparing anything.
  expect "the baseline holds $(wc -l < "$WORK/facts.before") facts, $(wc -l < "$WORK/edges.before") edges and $(wc -l < "$WORK/feeds.before") feed entries" \
    test -s "$WORK/facts.before" -a -s "$WORK/edges.before" -a -s "$WORK/feeds.before"
  # Stop as an operator would. 3.8.1 does not handle SIGTERM, so this is the
  # unclean stop every 3.8.1 container gets; PostgreSQL recovers on next start.
  echo "3.8.1 stop exit code: $(stop jr-subject)"
  docker rm jr-subject >/dev/null
  cp -a "$WORK/data" "$WORK/golden"

  heading "Phase B: upgrade the same data folder to $IMAGE_NEW"
  start jr-subject "$IMAGE_NEW" open 18080 "$WORK/data" || { fail "4.0 subject started"; return; }
  local saw_setup=false body
  for _ in $(seq 1 60); do
    body=$(curl -s localhost:18080/ready)
    [[ "$body" == *"database setup"* ]] && saw_setup=true
    [[ "$body" == *'"ready"'* ]] && break
    sleep 0.25
  done
  expect "the upgraded replicator becomes ready" grep -q '"ready"' <<<"$body"
  echo "      (/ready reported \"database setup\" while it ran: $saw_setup)"
  expect "start.sh applied setup.sql" bash -c "docker logs jr-subject 2>&1 | grep -q 'Database setup: complete.'"
  expect "no FATAL or ERROR lines from PostgreSQL" bash -c "! docker logs jr-subject 2>&1 | grep -E '(FATAL|ERROR):'"
  expect "the constraint was added NOT VALID" test "$(validated jr-subject)" = false
  snapshot jr-subject > "$WORK/facts.upgraded"
  expect "every fact is unchanged by the upgrade" cmp -s "$WORK/facts.before" "$WORK/facts.upgraded"
  feeds_of 18080 > "$WORK/feeds.upgraded"
  expect "every feed returns the same facts after the upgrade" cmp -s "$WORK/feeds.before" "$WORK/feeds.upgraded"
  expect "the server warns that the order needs repair" bash -c "docker logs jr-subject 2>&1 | grep -q 'Run repair-edge-order.sql'"

  docker restart jr-subject >/dev/null; wait_ready 18080 >/dev/null
  expect "a second start leaves the schema as it is" test "$(validated jr-subject)" = false

  heading "Phase B: repair, by the documented procedure"
  node seed.mjs bookmarks http://localhost:18080/jinaga > "$WORK/bookmarks"
  local t0=$SECONDS
  expect "repair-edge-order.sql succeeds" docker exec jr-subject \
    psql -q -v ON_ERROR_STOP=1 -U postgres -d replicator -f /replicator/node_modules/jinaga-server/repair-edge-order.sql
  echo "      (repair took $((SECONDS - t0)) s for $(psql_in jr-subject 'select count(*) from fact') facts)"
  expect "no inverted edges remain" test "$(inversions jr-subject)" = 0
  expect "the constraint is validated" test "$(validated jr-subject)" = true
  docker restart jr-subject >/dev/null; wait_ready 18080 >/dev/null
  snapshot jr-subject > "$WORK/facts.repaired"
  edges jr-subject > "$WORK/edges.repaired"
  expect "the repair keeps every fact" cmp -s "$WORK/facts.before" "$WORK/facts.repaired"
  expect "the repair keeps every predecessor" cmp -s "$WORK/edges.before" "$WORK/edges.repaired"
  feeds_of 18080 > "$WORK/feeds.repaired"
  expect "every feed returns the same facts after the repair" cmp -s "$WORK/feeds.before" "$WORK/feeds.repaired"
  expect "the warning is gone after the repair" bash -c "! since_last_start jr-subject | grep -q 'ck_edge_successor_after_predecessor'"
  expect "a reader resuming from a bookmark taken before the repair misses nothing" \
    node seed.mjs resume http://localhost:18080/jinaga "$WORK/bookmarks"
  node seed.mjs reverse http://localhost:18080/jinaga >/dev/null
  expect "a successor-first save on 4.0 writes no inverted edge" test "$(inversions jr-subject)" = 0

  feeds_of 18080 > "$WORK/feeds.final"

  heading "Phase B: shut down"
  local t1=$SECONDS code; code=$(stop jr-subject)
  expect "docker stop exits 0 (was $code, $((SECONDS - t1)) s)" test "$code" = 0
  expect "PostgreSQL shut down cleanly" bash -c "docker logs jr-subject 2>&1 | tail -3 | grep -q 'database system is shut down'"
  docker rm jr-subject >/dev/null
}

fresh() {
  heading "Phase C: fresh install of $IMAGE_NEW"
  rm -rf "$WORK/fresh"
  start jr-fresh "$IMAGE_NEW" open 18081 "$WORK/fresh" || { fail "fresh replicator started"; return; }
  expect "a fresh replicator becomes ready" wait_ready 18081
  expect "the constraint is validated on a fresh database" test "$(validated jr-fresh)" = true
  node seed.mjs seed http://localhost:18081/jinaga >/dev/null
  feeds_of 18081 >/dev/null
  expect "a fresh database writes no inverted edge" test "$(inversions jr-fresh)" = 0
  expect "a fresh database logs no constraint warning" bash -c "! docker logs jr-fresh 2>&1 | grep -q ck_edge_successor_after_predecessor"
  start jr-skip "$IMAGE_NEW" open 18082 - -e JINAGA_SKIP_DATABASE_SETUP=true
  expect "JINAGA_SKIP_DATABASE_SETUP=true starts without setup" wait_ready 18082
  expect "and says it skipped" bash -c "docker logs jr-skip 2>&1 | grep -q 'Database setup: skipped'"
  docker rm -f jr-fresh jr-skip >/dev/null

  if [ -d "$WORK/golden" ]; then
    # A setup that fails must not keep the replicator down: 3.x's schema
    # serves correctly. Point setup at a database that does not exist.
    rm -rf "$WORK/failing" && cp -a "$WORK/golden" "$WORK/failing"
    start jr-failing "$IMAGE_NEW" open 18084 "$WORK/failing" -e APP_DATABASE=missing
    expect "a failed setup still lets the replicator start" wait_ready 18084
    expect "and logs that setup failed" bash -c "docker logs jr-failing 2>&1 | grep -q 'Database setup: FAILED'"
    docker rm -f jr-failing >/dev/null
  fi
}

rollback() {
  heading "Phase D: roll back to $IMAGE_OLD on an upgraded, repaired folder"
  [ -d "$WORK/data" ] || { echo "skipped: run the upgrade section first"; return; }
  start jr-rollback "$IMAGE_OLD" open 18083 "$WORK/data"
  expect "3.8.1 starts on the upgraded folder" wait_ready 18083
  feeds_of 18083 > "$WORK/feeds.rollback"
  expect "3.8.1 serves the same feeds" cmp -s "$WORK/feeds.final" "$WORK/feeds.rollback"
  local r
  r=$(node seed.mjs forward http://localhost:18083/jinaga)
  expect "3.8.1 accepts a predecessors-first save, as clients send ($r)" grep -q '^201' <<<"$r"
  r=$(node seed.mjs reverse http://localhost:18083/jinaga)
  expect "3.8.1 refuses a successor-first save while the constraint exists ($r)" grep -q '^500' <<<"$r"
  docker exec jr-rollback psql -q -U postgres -d replicator -c "ALTER TABLE public.edge DROP CONSTRAINT ck_edge_successor_after_predecessor"
  r=$(node seed.mjs reverse http://localhost:18083/jinaga)
  expect "dropping the constraint completes the rollback ($r)" grep -q '^201' <<<"$r"
  docker rm -f jr-rollback >/dev/null
}

probes() {
  local pair img mode spec group fixture out
  for pair in "$IMAGE_OLD old" "$IMAGE_NEW new"; do
    read -r img mode <<<"$pair"
    heading "Probes against $img"
    for fixture in refuse-disconnected refuse-product refuse-subscription; do
      start jr-probe "$img" $fixture 18090 -
      out=$(wait_ready 18090)
      if [ $mode = new ]; then
        expect "F4 $fixture fails initialization" grep -q "initialization failed" <<<"$out"
      else
        echo "INFO  F4 $fixture: $out"
      fi
      docker rm -f jr-probe >/dev/null
    done
    for spec in "shapes open" "lineLimit open" "batch batch" "feeds feeds" "givenOnly given-only"; do
      read -r group fixture <<<"$spec"
      start jr-probe "$img" $fixture 18090 -
      if wait_ready 18090 >/dev/null; then
        node probes.mjs $group http://localhost:18090/jinaga $mode | grep -E '^(PASS|FAIL|INFO)' | tee "$WORK/probe.out"
        failures=$((failures + $(grep -c '^FAIL' "$WORK/probe.out")))
      elif [ $mode = new ]; then
        fail "$group: the $fixture replicator did not start: $(curl -s localhost:18090/ready)"
      else
        echo "INFO  $group: the $fixture replicator does not start on $img"
        docker logs jr-probe 2>&1 | grep -m1 'Error initializing' | cut -c1-200 | sed 's/^/      /'
      fi
      docker rm -f jr-probe >/dev/null
    done
    if [ $mode = new ]; then
      start jr-probe "$img" open 18090 - -e JINAGA_MAX_SAVE_LINE_BYTES=4194304
      wait_ready 18090 >/dev/null
      EXPECT_LIMIT=4194304 node probes.mjs lineLimit http://localhost:18090/jinaga new | grep -E '^(PASS|FAIL)' | tee "$WORK/probe.out"
      failures=$((failures + $(grep -c '^FAIL' "$WORK/probe.out")))
      start jr-probe "$img" open 18090 - -e JINAGA_MAX_SAVE_LINE_BYTES=1MB
      out=$(wait_ready 18090)
      expect "F13 JINAGA_MAX_SAVE_LINE_BYTES=1MB fails initialization, naming the variable" \
        bash -c "grep -q 'initialization failed' <<<'$out' && docker logs jr-probe 2>&1 | grep -q 'JINAGA_MAX_SAVE_LINE_BYTES is set to'"
      docker rm -f jr-probe >/dev/null
    fi
  done
}

mesh() {
  local pair img mode given
  for pair in "$IMAGE_OLD old" "$IMAGE_NEW new"; do
    read -r img mode <<<"$pair"
    heading "Mesh on $img"
    start jr-picky "$img" picky 18091 -
    start jr-up "$img" open 18092 -
    wait_ready 18091 >/dev/null; wait_ready 18092 >/dev/null
    start jr-pusher "$img" open 18093 - -e REPLICATOR_UPSTREAM_1=http://jr-picky:8080/jinaga
    start jr-down "$img" downstream 18094 - -e REPLICATOR_UPSTREAM_1=http://jr-up:8080/jinaga
    # F19: a subscription whose condition joins only its given.
    start jr-given "$img" given-only 18095 - -e REPLICATOR_UPSTREAM_1=http://jr-up:8080/jinaga
    wait_ready 18093 >/dev/null; wait_ready 18094 >/dev/null
    if wait_ready 18095 >/dev/null; then given=ready; else given=failed; fi
    GIVEN_ONLY=$given node mesh.mjs $mode | grep -E '^(PASS|FAIL|INFO)' | tee "$WORK/mesh.out"
    [ $mode = new ] && failures=$((failures + $(grep -c '^FAIL' "$WORK/mesh.out")))
    [ $given = failed ] && docker logs jr-given 2>&1 | grep -m1 'Error initializing' | cut -c1-200 | sed 's/^/      /'
    docker rm -f jr-picky jr-up jr-pusher jr-down jr-given >/dev/null

    # F12: an upstream that reports a feed decision this client does not know.
    docker rm -f jr-stub >/dev/null 2>&1
    docker run -d --platform "$PLATFORM" --name jr-stub --network $NET -v "$here/stub.mjs:/stub/stub.mjs:ro" \
      --entrypoint node "$IMAGE_NEW" /stub/stub.mjs >/dev/null
    start jr-down "$img" downstream 18094 - -e REPLICATOR_UPSTREAM_1=http://jr-stub:8080/jinaga
    wait_ready 18094 >/dev/null; sleep 5
    local read_feed=false refused=false
    docker logs jr-stub 2>&1 | grep -q 'GET /jinaga/feeds/stubfeed' && read_feed=true
    docker logs jr-down 2>&1 | grep -q -i -E 'Error running subscription|ValidationError|decision' && refused=true
    if [ $mode = new ]; then
      expect "F12 an unknown feed decision does not stop the subscription (read the feed: $read_feed, logged an error: $refused)" \
        test $read_feed = true -a $refused = false
    else
      echo "INFO  F12 unknown feed decision: read the feed: $read_feed, logged an error: $refused"
    fi
    docker logs jr-down 2>&1 | grep -i -m2 -E 'subscription|decision' | cut -c1-200 | sed 's/^/      /'
    docker rm -f jr-stub jr-down >/dev/null
  done
}

metrics() {
  heading "Metrics: OpenTelemetryTracer.metric reuses its instruments"
  (cd ../.. && npm run build --silent) && node metrics.mjs | tee "$WORK/metrics.out"
  failures=$((failures + $(grep -c '^FAIL' "$WORK/metrics.out")))
}

for s in "${sections[@]}"; do "$s"; done
echo
if [ $failures -eq 0 ]; then echo "All checks passed."; else echo "$failures check(s) failed."; fi
exit $((failures > 0))
