#!/usr/bin/env bash
set -Eeuo pipefail

# This installs a separate public test instance. It never changes the live
# /opt/numeral-lord-next checkout or restarts numeral-lord.service.
APP_DIR=/opt/numeral-lord-next-staging
ARCHIVE=/tmp/numeral-lord-next-staging.tar.gz
SITE_FILE=/etc/nginx/sites-available/digital-lord
SNIPPET=/etc/nginx/snippets/numeral-lord-staging.conf
INCLUDE='    include /etc/nginx/snippets/numeral-lord-staging.conf;'

[[ -f "$ARCHIVE" ]] || { echo "Missing staging archive: $ARCHIVE" >&2; exit 1; }
[[ -f "$SITE_FILE" ]] || { echo "Missing Nginx site: $SITE_FILE" >&2; exit 1; }
[[ ! -e "$APP_DIR" && ! -L "$APP_DIR" ]] || { echo "Staging directory already exists: $APP_DIR" >&2; exit 1; }
[[ ! -e "$SNIPPET" && ! -L "$SNIPPET" ]] || { echo "Staging Nginx snippet already exists" >&2; exit 1; }
[[ ! -e /etc/systemd/system/numeral-lord-staging.service ]] || { echo "Staging service already exists" >&2; exit 1; }

install -d -m 755 "$APP_DIR"
tar -xzf "$ARCHIVE" -C "$APP_DIR"
find "$APP_DIR" -name node_modules -prune -o -type d -exec chmod 755 {} +
find "$APP_DIR" -name node_modules -prune -o -type f -exec chmod 644 {} +
cd "$APP_DIR"
export PATH="/opt/numeral-lord-runtime/current/bin:$PATH"
pnpm install --frozen-lockfile --force
pnpm --filter @numeral-lord/game-core build
pnpm --filter @numeral-lord/web exec vite build --base=/numeral-lord-play-stage/
chown -R numeral-lord:numeral-lord "$APP_DIR"

install -m 644 deploy/numeral-lord-staging.service /etc/systemd/system/numeral-lord-staging.service
systemctl daemon-reload
systemctl enable --now numeral-lord-staging.service
READY=0
for _ in $(seq 1 30); do
  if systemctl is-active --quiet numeral-lord-staging.service \
    && curl --fail --silent http://127.0.0.1:2571/ >/dev/null; then
    READY=1
    break
  fi
  sleep 0.5
done
[[ "$READY" == 1 ]] || { echo "Staging relay did not become healthy" >&2; exit 1; }

install -m 644 deploy/nginx-staging-location.conf "$SNIPPET"
SITE_BACKUP="${SITE_FILE}.bak-numeral-lord-staging-$(date +%Y%m%d-%H%M%S)"
cp -a "$SITE_FILE" "$SITE_BACKUP"
if ! grep -qF "$INCLUDE" "$SITE_FILE"; then
  SITE_TEMP="$(mktemp "${SITE_FILE}.staging.XXXXXX")"
  awk -v include_line="$INCLUDE" '
    { print }
    /include \/etc\/nginx\/snippets\/numeral-lord\.conf;/ { print include_line; inserted = 1 }
    END { if (!inserted) exit 42 }
  ' "$SITE_FILE" > "$SITE_TEMP"
  install -m 644 "$SITE_TEMP" "$SITE_FILE"
  rm -- "$SITE_TEMP"
fi
if ! nginx -t; then
  install -m 644 "$SITE_BACKUP" "$SITE_FILE"
  echo "Nginx validation failed; site configuration restored from $SITE_BACKUP" >&2
  exit 1
fi
systemctl reload nginx
echo "Staging is live. Nginx site backup: $SITE_BACKUP"
