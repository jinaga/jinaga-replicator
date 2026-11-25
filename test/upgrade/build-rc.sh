#!/bin/bash
# Build a release-candidate image from the working tree.
#
#   test/upgrade/build-rc.sh [jinaga-server.tgz]
#
# With no argument this is a plain `docker build`. Given a jinaga-server
# tarball (from `npm pack` in jinaga-server), it builds against that instead of
# the published package, so a replicator release can be tested before
# jinaga-server is on npm. It does so in a temporary copy of the build context,
# leaving the working tree untouched.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
tag="${RC_TAG:-jinaga-replicator:rc}"
platform="${PLATFORM:-linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}"

if [ $# -eq 0 ]; then
  docker build --platform "$platform" -t "$tag" "$repo"
  exit 0
fi

tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT

(cd "$repo" && git ls-files -co --exclude-standard | grep -v '^test/' | tar cf - -T -) | tar xf - -C "$context"
mkdir "$context/vendor"
cp "$tarball" "$context/vendor/jinaga-server.tgz"
(cd "$context" && npm install --package-lock-only --silent ./vendor/jinaga-server.tgz)
# Both stages run npm ci, so both need the tarball the lock file now names.
sed -i.bak 's#^COPY package-lock.json .$#&\nCOPY vendor vendor#' "$context/Dockerfile"
sed -i.bak 's#^COPY --from=build /replicator/package-lock.json .$#&\nCOPY --from=build /replicator/vendor vendor#' "$context/Dockerfile"
grep -c 'COPY.*vendor' "$context/Dockerfile" | grep -q 2

docker build --platform "$platform" -t "$tag" "$context"
