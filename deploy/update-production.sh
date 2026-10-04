#!/usr/bin/env bash
set -Eeuo pipefail

# 先完整构建候选版本；发布成功后只保留当前运行目录。
# 发布期间的旧目录仅用于失败回滚，成功后立即删除。
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
if [[ "$ACTIVE_CONNECTIONS" -gt 0 && "${ALLOW_ACTIVE_CONNECTIONS:-0}" != 1 ]]; then
  echo "Production has $ACTIVE_CONNECTIONS active TCP connection(s); refusing to interrupt live rooms." >&2
  exit 1
fi
if [[ "$ACTIVE_CONNECTIONS" -gt 0 ]]; then
  echo "Explicit test-deployment override: restarting with $ACTIVE_CONNECTIONS active connection(s)." >&2
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
ROLLBACK_DIR="/opt/.numeral-lord-next-rollback-$STAMP"
UNIT_ROLLBACK_FILE=""
CANDIDATE=""
DEPLOY_SWITCH_STARTED=0
DEPLOY_SUCCEEDED=0
[[ ! -e "$ROLLBACK_DIR" ]] || {
  echo "A temporary production rollback path already exists." >&2
  exit 1
}

CANDIDATE="$(mktemp -d /opt/numeral-lord-next-candidate.XXXXXXXX)"
UNIT_ROLLBACK_FILE="$(mktemp /tmp/numeral-lord.service.XXXXXX)"

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  cd /

  if [[ "$DEPLOY_SWITCH_STARTED" == 1 && "$DEPLOY_SUCCEEDED" != 1 ]]; then
    systemctl stop numeral-lord.service >/dev/null 2>&1
    if [[ -d "$ROLLBACK_DIR" ]]; then
      if [[ -e "$APP_DIR" ]]; then rm -rf -- "$APP_DIR"; fi
      mv "$ROLLBACK_DIR" "$APP_DIR"
      install -m 644 "$UNIT_ROLLBACK_FILE" "$UNIT"
      systemctl daemon-reload
    fi
    systemctl start numeral-lord.service
  fi

  if [[ -n "$CANDIDATE" && -d "$CANDIDATE" ]]; then rm -rf -- "$CANDIDATE"; fi
  if [[ -n "$UNIT_ROLLBACK_FILE" && -f "$UNIT_ROLLBACK_FILE" ]]; then rm -f -- "$UNIT_ROLLBACK_FILE"; fi
  exit "$exit_code"
}
trap cleanup EXIT

cp -a "$UNIT" "$UNIT_ROLLBACK_FILE"
tar -xzf "$ARCHIVE" -C "$CANDIDATE"
find "$CANDIDATE" -name node_modules -prune -o -type d -exec chmod 755 {} +
find "$CANDIDATE" -name node_modules -prune -o -type f -exec chmod 644 {} +
cd "$CANDIDATE"
export PATH="$RUNTIME:$PATH"
pnpm install --frozen-lockfile --force
pnpm --filter @numeral-lord/game-core build
pnpm --filter @numeral-lord/web exec vite build --base=/numeral-lord-play/

# 保留工坊资源文件；数据库仍由独立 PostgreSQL 持久化。
if [[ -d "$APP_DIR/apps/server/data" ]]; then
  cp -a "$APP_DIR/apps/server/data" "$CANDIDATE/apps/server/data"
fi
chown -R numeral-lord:numeral-lord "$CANDIDATE"

# PostgreSQL 使用本机 peer 认证；此处只确保应用角色可创建项目表。
sudo -u postgres psql -v ON_ERROR_STOP=1 -d numeral_lord <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'numeral-lord') THEN
    CREATE ROLE "numeral-lord" LOGIN;
  END IF;
END
$$;
GRANT CONNECT ON DATABASE numeral_lord TO "numeral-lord";
GRANT USAGE, CREATE ON SCHEMA public TO "numeral-lord";
SQL

DEPLOY_SWITCH_STARTED=1
systemctl stop numeral-lord.service
mv "$APP_DIR" "$ROLLBACK_DIR"
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
  echo "新正式版本健康检查失败，正在恢复此前运行版本。" >&2
  exit 1
fi

DEPLOY_SUCCEEDED=1
if ! rm -rf -- "$ROLLBACK_DIR"; then
  echo "正式版本已更新，但临时旧目录未能删除：$ROLLBACK_DIR" >&2
  exit 1
fi
rm -f -- "$ARCHIVE"
echo "Production updated. Only the active checkout is retained."
