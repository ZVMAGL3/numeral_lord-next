#!/usr/bin/env bash
set -Eeuo pipefail

# Build a complete candidate before switching the public production service.
# The old checkout and unit are retained for rollback.
APP_DIR=/opt/numeral-lord-next
ARCHIVE=/tmp/numeral-lord-next-production.tar.gz
UNIT=/etc/systemd/system/numeral-lord.service
RUNTIME=/opt/numeral-lord-runtime/current/bin

[[ -f "$ARCHIVE" && -d "$APP_DIR" && -f "$UNIT" ]] || {
  echo "Production archive, checkout or service unit is missing." >&2
  exit 1
}
[[ "$(realpath -m "$APP_DIR")" == /opt/numeral-lord-next ]] || exit 1
ACTIVE_CONNECTIONS="$(ss -Hnt state established '( sport = :2567 )' | wc -l)"
if [[ "$ACTIVE_CONNECTIONS" -gt 0 ]]; then
  echo "Production has $ACTIVE_CONNECTIONS active TCP connection(s); refusing to interrupt live rooms." >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/numeral-lord-next-backup-$STAMP"
FAILED="/opt/numeral-lord-next-failed-$STAMP"
UNIT_BACKUP="${UNIT}.bak-$STAMP"
[[ ! -e "$BACKUP" && ! -e "$FAILED" && ! -e "$UNIT_BACKUP" ]] || {
  echo "A production rollback path already exists." >&2
  exit 1
}

CANDIDATE="$(mktemp -d /opt/numeral-lord-next-candidate.XXXXXXXX)"
tar -xzf "$ARCHIVE" -C "$CANDIDATE"
find "$CANDIDATE" -name node_modules -prune -o -type d -exec chmod 755 {} +
find "$CANDIDATE" -name node_modules -prune -o -type f -exec chmod 644 {} +
cd "$CANDIDATE"
export PATH="$RUNTIME:$PATH"
pnpm install --frozen-lockfile --force
pnpm --filter @numeral-lord/game-core build
pnpm --filter @numeral-lord/web exec vite build --base=/numeral-lord-play/

# Keep workshop/map submissions across releases, even though app source is replaced.
if [[ -d "$APP_DIR/apps/server/data" ]]; then
  cp -a "$APP_DIR/apps/server/data" "$CANDIDATE/apps/server/data"
fi
chown -R numeral-lord:numeral-lord "$CANDIDATE"

cp -a "$UNIT" "$UNIT_BACKUP"
systemctl stop numeral-lord.service
mv "$APP_DIR" "$BACKUP"
mv "$CANDIDATE" "$APP_DIR"
install -m 644 "$APP_DIR/deploy/numeral-lord.service" "$UNIT"
systemctl daemon-reload
systemctl start numeral-lord.service

READY=0
for _ in $(seq 1 90); do
  if systemctl is-active --quiet numeral-lord.service \
    && curl --fail --silent http://127.0.0.1:2567/ >/dev/null \
    && curl --fail --silent http://127.0.0.1/numeral-lord-play/ >/dev/null; then
    READY=1
    break
  fi
  sleep 0.5
done

if [[ "$READY" != 1 ]]; then
  systemctl stop numeral-lord.service || true
  mv "$APP_DIR" "$FAILED"
  mv "$BACKUP" "$APP_DIR"
  install -m 644 "$UNIT_BACKUP" "$UNIT"
  systemctl daemon-reload
  systemctl start numeral-lord.service
  echo "New production release failed; previous release restored. Failed files: $FAILED" >&2
  exit 1
fi

echo "Production updated. Previous checkout: $BACKUP; previous unit: $UNIT_BACKUP"
