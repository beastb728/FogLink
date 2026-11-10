#!/bin/sh
# Runs the Go toolchain in Docker, so Go itself need not be installed.
#   server/go.sh test -count=1 -v ./...
#   server/go.sh build -o foglink-relay .
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
cache="${HOME}/.cache/foglink-go"
mkdir -p "$cache"
exec docker run --rm -u "$(id -u):$(id -g)" \
  -e HOME=/cache -e GOCACHE=/cache/build -e GOPATH=/cache/go -e CGO_ENABLED=0 \
  ${FOGLINK_TEST_REDIS:+-e FOGLINK_TEST_REDIS="$FOGLINK_TEST_REDIS"} ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} \
  -v "$cache":/cache -v "$dir":/src -w /src golang:1.23 go "$@"
