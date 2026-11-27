#!/bin/bash
# Build a release-candidate image from the working tree.
#
#   test/upgrade/build-rc.sh [package.tgz ...]
#
# With no argument this is a plain `docker build`. Given package tarballs (from
# `npm pack` in jinaga-server or jinaga.js), it builds against those instead of
# the published packages, so a replicator release can be tested before they are
# on npm. A jinaga tarball also serves jinaga-server, whose range it satisfies.
# It does so in a temporary copy of the build context, leaving the working tree
# untouched.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
tag="${RC_TAG:-jinaga-replicator:rc}"
platform="${PLATFORM:-linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}"

if [ $# -eq 0 ]; then
  docker build --platform "$platform" -t "$tag" "$repo"
  exit 0
fi

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT

(cd "$repo" && git ls-files -co --exclude-standard | grep -v '^test/' | tar cf - -T -) | tar xf - -C "$context"
mkdir "$context/vendor"
packages=()
for tarball in "$@"; do
  cp "$tarball" "$context/vendor/"
  packages+=("./vendor/$(basename "$tarball")")
done
(cd "$context" && npm install --package-lock-only --silent "${packages[@]}")
# Both stages run npm ci, so both need the tarballs the lock file now names.
sed -i.bak 's#^COPY package-lock.json .$#&\nCOPY vendor vendor#' "$context/Dockerfile"
sed -i.bak 's#^COPY --from=build /replicator/package-lock.json .$#&\nCOPY --from=build /replicator/vendor vendor#' "$context/Dockerfile"
grep -c 'COPY.*vendor' "$context/Dockerfile" | grep -q 2

docker build --platform "$platform" -t "$tag" "$context"
