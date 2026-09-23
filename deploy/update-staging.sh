#!/usr/bin/env bash
set -Eeuo pipefail

# Refresh only the public test instance. The live service and checkout are
# never touched. The previous staging checkout stays as a dated rollback.
APP_DIR=/opt/numeral-lord-next-staging
ARCHIVE=/tmp/numeral-lord-next-staging.tar.gz
UNIT=/etc/systemd/system/numeral-lord-staging.service
RUNTIME=/opt/numeral-lord-runtime/current/bin

[[ -f "$ARCHIVE" && -d "$APP_DIR" && -f "$UNIT" ]] || {
  echo "Staging archive, checkout or service unit is missing." >&2
  exit 1
}
[[ "$(realpath -m "$APP_DIR")" == /opt/numeral-lord-next-staging ]] || exit 1

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/numeral-lord-next-staging-backup-$STAMP"
FAILED="/opt/numeral-lord-next-staging-failed-$STAMP"
UNIT_BACKUP="${UNIT}.bak-$STAMP"
[[ ! -e "$BACKUP" && ! -e "$FAILED" && ! -e "$UNIT_BACKUP" ]] || {
  echo "A staging rollback path already exists." >&2
  exit 1
}

CANDIDATE="$(mktemp -d /opt/numeral-lord-next-staging-candidate.XXXXXXXX)"
tar -xzf "$ARCHIVE" -C "$CANDIDATE"
# Windows-created tarballs may mark source directories 0777 and the mktemp
# root starts 0700. Normalize both so Nginx can read the site without making
# the source tree writable by every local account. pnpm owns node_modules.
find "$CANDIDATE" -name node_modules -prune -o -type d -exec chmod 755 {} +
find "$CANDIDATE" -name node_modules -prune -o -type f -exec chmod 644 {} +
cd "$CANDIDATE"
export PATH="$RUNTIME:$PATH"
# pnpm's regular cached install can omit the native optional package used by
# tsx/esbuild. Force a complete platform install before the release is switched.
pnpm install --frozen-lockfile --force
pnpm --filter @numeral-lord/game-core build
pnpm --filter @numeral-lord/web exec vite build --base=/numeral-lord-play-stage/
# The workshop store lives below the staging checkout. Carry it forward so a
# code update never silently drops published test data.
if [[ -d "$APP_DIR/apps/server/data" ]]; then
  cp -a "$APP_DIR/apps/server/data" "$CANDIDATE/apps/server/data"
fi
chown -R numeral-lord:numeral-lord "$CANDIDATE"

# This is the only interruption, and it affects staging rooms only. The
# operator should check active staging connections and announce it first.
cp -a "$UNIT" "$UNIT_BACKUP"
systemctl stop numeral-lord-staging.service
mv "$APP_DIR" "$BACKUP"
mv "$CANDIDATE" "$APP_DIR"
install -m 644 "$APP_DIR/deploy/numeral-lord-staging.service" "$UNIT"
systemctl daemon-reload
systemctl start numeral-lord-staging.service

READY=0
for _ in $(seq 1 40); do
  if systemctl is-active --quiet numeral-lord-staging.service \
    && curl --fail --silent http://127.0.0.1:2571/ >/dev/null; then
    READY=1
    break
  fi
  sleep 0.5
done

if [[ "$READY" != 1 ]]; then
  systemctl stop numeral-lord-staging.service || true
  mv "$APP_DIR" "$FAILED"
  mv "$BACKUP" "$APP_DIR"
  install -m 644 "$UNIT_BACKUP" "$UNIT"
  systemctl daemon-reload
  systemctl start numeral-lord-staging.service
  echo "New staging release failed; previous staging restored. Failed files: $FAILED" >&2
  exit 1
fi

echo "Staging updated. Previous checkout: $BACKUP; previous unit: $UNIT_BACKUP"
