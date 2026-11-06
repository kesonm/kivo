#!/bin/sh
set -eu
# Clean only this application's disposable workers after an unclean API exit.
for kind in runner git; do
  ids="$(docker ps -aq --filter "label=codex-workspace.$kind=true")"
  if [ -n "$ids" ]; then
    docker rm -f $ids >/dev/null
  fi
done
networks="$(docker network ls -q --filter label=codex-workspace.run-network=true)"
for network in $networks; do
  docker network disconnect -f "$network" "$HOSTNAME" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null
done
exec node server/app.mjs
