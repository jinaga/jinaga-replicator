# Shared helpers for the upgrade harness. Source this file.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 3.8.1 by its multi-platform index digest, so pulling it for PLATFORM never
# moves the local jinaga/jinaga-replicator:3.8.1 tag that other stacks run.
IMAGE_OLD="${IMAGE_OLD:-jinaga/jinaga-replicator@sha256:e36bbfbe85741f265e9d73e1ef92fc9fe40e754a3bdf82f92ac8a5d87aff7908}"
IMAGE_NEW="${IMAGE_NEW:-jinaga-replicator:rc}"
PLATFORM="${PLATFORM:-linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}"
WORK="${WORK:-$here/.work}"
NET=jr-upgrade
mkdir -p "$WORK"
docker network inspect $NET >/dev/null 2>&1 || docker network create $NET >/dev/null

# start NAME IMAGE FIXTURE PORT [DATA_DIR] [docker run args...]
# DATA_DIR "-" means a throwaway data folder.
start() {
  local name=$1 image=$2 fixture=$3 port=$4 data=${5:--}
  shift 5 2>/dev/null || shift $#
  local f="$here/fixtures/$fixture"
  local volume=()
  if [ "$data" != "-" ]; then mkdir -p "$data"; volume=(-v "$data:/var/lib/postgresql/data"); fi
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --platform "$PLATFORM" --name "$name" --network $NET -p "$port:8080" \
    ${volume[@]+"${volume[@]}"} \
    -v "$f/policies:/var/lib/replicator/policies:ro" \
    -v "$f/authentication:/var/lib/replicator/authentication:ro" \
    -v "$f/subscriptions:/var/lib/replicator/subscriptions:ro" \
    "$@" "$image" >/dev/null || { echo "could not start $name" >&2; return 1; }
}

# wait_ready PORT: prints the final /ready body; returns 0 once ready, 1 on failure.
wait_ready() {
  local body
  for _ in $(seq 1 240); do
    body=$(curl -s "localhost:$1/ready")
    case "$body" in
      *'"ready"'*) echo "$body"; return 0;;
      *'initialization failed'*) echo "$body"; return 1;;
    esac
    sleep 0.5
  done
  echo "$body"; return 1
}

psql_in() { docker exec "$1" psql -U postgres -d replicator -Atc "$2"; }

count_type() { psql_in "$1" "select count(*) from fact f join fact_type t on t.fact_type_id = f.fact_type_id where t.name = '$2'"; }

stop() { docker stop "$1" >/dev/null 2>&1; docker inspect "$1" --format '{{.State.ExitCode}}'; }
