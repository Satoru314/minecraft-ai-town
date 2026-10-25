#!/bin/bash
# bot を systemd サービスとして入れる（何度実行してもよい）。
# このリポジトリを /opt/minecraft-ai-town に置いて root で実行する。
# 初回は /etc/default/minecraft-ai-town を config/bot.env.example から作るので、MC_HOST を書き換えてから再実行する。
set -euo pipefail
repo="$(cd "$(dirname "$0")" && pwd)"
if [[ "$repo" != /opt/minecraft-ai-town ]]; then
  echo "このリポジトリは /opt/minecraft-ai-town に置いてください" >&2
  exit 1
fi
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  echo "Node.js 22 以上が必要です" >&2
  exit 1
fi

command -v python3 >/dev/null || (DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 >/dev/null)  # bin/status 用
id mcai >/dev/null 2>&1 || useradd --system --home /var/lib/minecraft-ai-town --shell /usr/sbin/nologin mcai
install -d -o mcai -g mcai /var/lib/minecraft-ai-town

cd "$repo"
npm ci --omit=dev --no-audit --no-fund --loglevel=error

if [[ ! -f /etc/default/minecraft-ai-town ]]; then
  install -m 644 config/bot.env.example /etc/default/minecraft-ai-town
  echo "/etc/default/minecraft-ai-town を作りました。MC_HOST を接続先に書き換えて、もう一度実行してください" >&2
  exit 1
fi

install -m 644 systemd/minecraft-ai-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q minecraft-ai-bot.service
systemctl restart minecraft-ai-bot.service
echo "started. logs: journalctl -u minecraft-ai-bot -f / status: bin/status"
