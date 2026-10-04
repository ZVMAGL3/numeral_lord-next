#!/usr/bin/env bash
set -Eeuo pipefail

# 只更新测试环境，不触碰正式服务。
# 发布期间的旧目录仅用于失败回滚，成功后立即删除。
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
ROLLBACK_DIR="/opt/.numeral-lord-next-staging-rollback-$STAMP"
UNIT_ROLLBACK_FILE=""
CANDIDATE=""
DEPLOY_SWITCH_STARTED=0
DEPLOY_SUCCEEDED=0
[[ ! -e "$ROLLBACK_DIR" ]] || {
  echo "A temporary staging rollback path already exists." >&2
  exit 1
}

CANDIDATE="$(mktemp -d /opt/numeral-lord-next-staging-candidate.XXXXXXXX)"
UNIT_ROLLBACK_FILE="$(mktemp /tmp/numeral-lord-staging.service.XXXXXX)"

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  cd /

  if [[ "$DEPLOY_SWITCH_STARTED" == 1 && "$DEPLOY_SUCCEEDED" != 1 ]]; then
    systemctl stop numeral-lord-staging.service >/dev/null 2>&1
    if [[ -d "$ROLLBACK_DIR" ]]; then
      if [[ -e "$APP_DIR" ]]; then rm -rf -- "$APP_DIR"; fi
      mv "$ROLLBACK_DIR" "$APP_DIR"
      install -m 644 "$UNIT_ROLLBACK_FILE" "$UNIT"
      systemctl daemon-reload
    fi
    systemctl start numeral-lord-staging.service
  fi

  if [[ -n "$CANDIDATE" && -d "$CANDIDATE" ]]; then rm -rf -- "$CANDIDATE"; fi
  if [[ -n "$UNIT_ROLLBACK_FILE" && -f "$UNIT_ROLLBACK_FILE" ]]; then rm -f -- "$UNIT_ROLLBACK_FILE"; fi
  exit "$exit_code"
}
trap cleanup EXIT

cp -a "$UNIT" "$UNIT_ROLLBACK_FILE"
tar -xzf "$ARCHIVE" -C "$CANDIDATE"
# Windows 生成的归档可能带有过宽权限；规范权限以便 Nginx 可读且目录不可被任意用户写入。
find "$CANDIDATE" -name node_modules -prune -o -type d -exec chmod 755 {} +
find "$CANDIDATE" -name node_modules -prune -o -type f -exec chmod 644 {} +
cd "$CANDIDATE"
export PATH="$RUNTIME:$PATH"
# 强制完整安装当前平台依赖，避免遗漏 tsx/esbuild 使用的原生可选包。
pnpm install --frozen-lockfile --force
pnpm --filter @numeral-lord/game-core build
pnpm --filter @numeral-lord/web exec vite build --base=/numeral-lord-play-stage/
# 保留测试工坊文件资源；数据库仍由独立 PostgreSQL 持久化。
if [[ -d "$APP_DIR/apps/server/data" ]]; then
  cp -a "$APP_DIR/apps/server/data" "$CANDIDATE/apps/server/data"
fi
chown -R numeral-lord:numeral-lord "$CANDIDATE"

# 只中断测试房间，不影响正式服务。
DEPLOY_SWITCH_STARTED=1
systemctl stop numeral-lord-staging.service
mv "$APP_DIR" "$ROLLBACK_DIR"
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
  echo "新测试版本健康检查失败，正在恢复此前运行版本。" >&2
  exit 1
fi

DEPLOY_SUCCEEDED=1
if ! rm -rf -- "$ROLLBACK_DIR"; then
  echo "测试版本已更新，但临时旧目录未能删除：$ROLLBACK_DIR" >&2
  exit 1
fi
rm -f -- "$ARCHIVE"
echo "Staging updated. Only the active checkout is retained."
