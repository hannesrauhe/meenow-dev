#!/usr/bin/env bash
# Local end-to-end test: MariaDB + PHP in Docker (no compose needed). Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."   # server/

NET=meenow-test-net
DB=meenow-test-db
cleanup() {
  docker rm -f "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # Remove root-owned artifacts the container left in the mounted dir.
  docker run --rm -v "$PWD:/app" alpine sh -c \
    'rm -rf /app/vendor /app/config; chown '"$(id -u):$(id -g)"' /app/composer.lock 2>/dev/null || true' >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create --subnet 172.28.0.0/24 "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" \
  -e MYSQL_DATABASE=meenow -e MYSQL_USER=meenow -e MYSQL_PASSWORD=meenowpw -e MYSQL_ROOT_PASSWORD=rootpw \
  mariadb:11 >/dev/null

docker build -q -f Dockerfile.test -t meenow-test . >/dev/null

echo "Waiting for MariaDB..."
docker run --rm --network "$NET" meenow-test sh -c \
  'for i in $(seq 1 60); do php -r "try { new PDO(\"mysql:host='"$DB"';dbname=meenow\", \"meenow\", \"meenowpw\"); exit(0); } catch (Throwable \$e) { exit(1); }" && exit 0; sleep 2; done; exit 1'

docker run --rm --network "$NET" -e DB_HOST="$DB" -v "$PWD:/app" -w /app meenow-test sh scripts/test-entrypoint.sh
