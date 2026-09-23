#!/usr/bin/env bash
set -Eeuo pipefail

NODE_VERSION="24.21.0"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
RUNTIME_DIR="/opt/numeral-lord-runtime/node-v${NODE_VERSION}"
RUNTIME_LINK="/opt/numeral-lord-runtime/current"
APP_DIR="/opt/numeral-lord-next"
DEPLOY_ARCHIVE="/tmp/numeral-lord-next-deploy.tar.gz"

if [[ ! -f "${DEPLOY_ARCHIVE}" ]]; then
  echo "Missing deployment archive: ${DEPLOY_ARCHIVE}" >&2
  exit 1
fi

if [[ ! -x "${RUNTIME_DIR}/bin/node" ]]; then
  install -d -m 755 "${RUNTIME_DIR}"
  curl -fL "https://nodejs.org/dist/latest-v24.x/${NODE_ARCHIVE}" -o "/tmp/${NODE_ARCHIVE}"
  printf '%s  %s\n' "${NODE_SHA256}" "/tmp/${NODE_ARCHIVE}" | sha256sum -c -
  tar -xJf "/tmp/${NODE_ARCHIVE}" --strip-components=1 -C "${RUNTIME_DIR}"
fi

ln -sfn "${RUNTIME_DIR}" "${RUNTIME_LINK}"
export PATH="${RUNTIME_LINK}/bin:${PATH}"

if [[ ! -x "${RUNTIME_DIR}/bin/pnpm" ]]; then
  "${RUNTIME_DIR}/bin/npm" install --global --prefix "${RUNTIME_DIR}" pnpm@12.5.1
fi

if ! id -u numeral-lord >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin numeral-lord
fi

install -d -m 755 "${APP_DIR}"
tar -xzf "${DEPLOY_ARCHIVE}" -C "${APP_DIR}"
cd "${APP_DIR}"

pnpm install --frozen-lockfile
pnpm --filter @numeral-lord/game-core build
chown -R numeral-lord:numeral-lord "${APP_DIR}"

install -m 644 "${APP_DIR}/deploy/numeral-lord.service" /etc/systemd/system/numeral-lord.service
systemctl daemon-reload
systemctl enable --now numeral-lord.service
systemctl restart numeral-lord.service

echo "Installed Node $(node --version), pnpm $(pnpm --version)."
systemctl --no-pager --full status numeral-lord.service
