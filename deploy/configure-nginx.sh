#!/usr/bin/env bash
set -Eeuo pipefail

SITE_LINK="/etc/nginx/sites-enabled/digital-lord"
SITE_FILE="$(readlink -f "${SITE_LINK}")"
SNIPPET_FILE="/etc/nginx/snippets/numeral-lord.conf"
INCLUDE_LINE="    include /etc/nginx/snippets/numeral-lord.conf;"
BACKUP_FILE="${SITE_FILE}.bak-numeral-lord-$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "${SITE_FILE}" ]]; then
  echo "Nginx site not found: ${SITE_FILE}" >&2
  exit 1
fi

install -m 644 /tmp/nginx-location.conf "${SNIPPET_FILE}"

if ! grep -qF "${INCLUDE_LINE}" "${SITE_FILE}"; then
  cp -a "${SITE_FILE}" "${BACKUP_FILE}"
  awk -v include_line="${INCLUDE_LINE}" '
    { print }
    /^[[:space:]]*index index\.html;[[:space:]]*$/ { print include_line; inserted = 1 }
    END { if (!inserted) exit 42 }
  ' "${SITE_FILE}" > "${SITE_FILE}.numeral-lord-new"
  install -m 644 "${SITE_FILE}.numeral-lord-new" "${SITE_FILE}"
fi

if ! nginx -t; then
  if [[ -f "${BACKUP_FILE}" ]]; then
    install -m 644 "${BACKUP_FILE}" "${SITE_FILE}"
  fi
  echo "Nginx validation failed; the previous site configuration was restored." >&2
  exit 1
fi

systemctl reload nginx
echo "Nginx route /numeral-lord/ is active."
