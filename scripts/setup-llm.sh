#!/bin/bash
# 判断係用の llama.cpp（llama-server）とモデルを /opt/llm に用意する（何度実行してもよい）。root で実行。
# ビルドに数分かかる。長く動くので、リモートでは systemd-run などで裏で動かすとよい。
set -euo pipefail
LLAMA_COMMIT=b3fa69955ea81c3b60e77e3c1e2224c4a826ffb9
MODEL_REPO=bartowski/Qwen_Qwen3.5-4B-GGUF
MODEL_REVISION=4168f45a16a1290d65a4ec0fa312ae917a4c15d6
MODEL_FILE=Qwen_Qwen3.5-4B-Q4_K_M.gguf
MODEL_SHA256=13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983

export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq git cmake build-essential libcurl4-openssl-dev >/dev/null
install -d /opt/llm /opt/llm/models

if [[ ! -d /opt/llm/llama.cpp ]]; then
  git clone -q https://github.com/ggml-org/llama.cpp /opt/llm/llama.cpp
fi
cd /opt/llm/llama.cpp
if [[ "$(git rev-parse HEAD)" != "$LLAMA_COMMIT" || ! -x build/bin/llama-server ]]; then
  git fetch -q --depth 1 origin "$LLAMA_COMMIT" && git checkout -q "$LLAMA_COMMIT"
  cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON >/dev/null
  cmake --build build -j "$(nproc)" --target llama-server llama-bench >/dev/null
fi

model=/opt/llm/models/$MODEL_FILE
if ! echo "$MODEL_SHA256  $model" | sha256sum -c --status 2>/dev/null; then
  curl -fsSL -o "$model.tmp" "https://huggingface.co/$MODEL_REPO/resolve/$MODEL_REVISION/$MODEL_FILE"
  echo "$MODEL_SHA256  $model.tmp" | sha256sum -c --status || { echo "checksum mismatch: $MODEL_FILE" >&2; exit 1; }
  mv "$model.tmp" "$model"
fi
chmod 644 "$model"
echo "llama-server: /opt/llm/llama.cpp/build/bin/llama-server"
echo "model: $model"
