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

# llama-server はモデルの読み込みに時間がかかるので、ユニットか設定が変わったときだけ再起動する
llm_before=$(cat /etc/systemd/system/minecraft-ai-llm.service /etc/default/minecraft-ai-town 2>/dev/null | sha256sum)
install -m 644 systemd/minecraft-ai-bot.service systemd/minecraft-ai-llm.service /etc/systemd/system/
llm_after=$(cat /etc/systemd/system/minecraft-ai-llm.service /etc/default/minecraft-ai-town 2>/dev/null | sha256sum)
systemctl daemon-reload

# 判断係: モデルが用意されていれば動かす（なければ bot は決め打ちの選び方で動く）。LLM_URL=off なら止める
. /etc/default/minecraft-ai-town
if [[ "${LLM_URL:-}" == off ]]; then
  systemctl disable -q --now minecraft-ai-llm.service 2>/dev/null || true
elif [[ -n "${LLM_MODEL:-}" && -f "$LLM_MODEL" && -x /opt/llm/llama.cpp/build/bin/llama-server ]]; then
  systemctl enable -q minecraft-ai-llm.service
  if [[ "$llm_before" != "$llm_after" ]] || ! systemctl is-active -q minecraft-ai-llm.service; then
    systemctl restart minecraft-ai-llm.service
  fi
else
  echo "判断係のモデルがないので minecraft-ai-llm は起動しません（scripts/setup-llm.sh で用意できます）" >&2
fi

systemctl enable -q minecraft-ai-bot.service
systemctl restart minecraft-ai-bot.service
echo "started. logs: journalctl -u minecraft-ai-bot -f / status: bin/status"
