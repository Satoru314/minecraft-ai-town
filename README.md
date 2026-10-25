# minecraft-ai-town

ローカルで動く AI が Minecraft のサバイバルワールドで暮らし、敵と戦いながら、ひたすら街を発展させ続けるシステム。
クラウドの AI API は使わず、すべて手元の CPU だけで動かす。

> **状態: 大きな街づくりの途中。** ローカルの Qwen3.5-4B が、素早く次の行動を選ぶ「判断係」と、数分おきに振り返って方針・教訓・建物の設計を考え、チャットでつぶやく「考える係」の2役をこなす。仕様は [docs/design.md](docs/design.md)、進め方は [docs/roadmap.md](docs/roadmap.md)。

## 動かし方（bot）

Node.js 22 以上のマシン（Debian 13 で確認）に送り込む:

```sh
bin/deploy root@<bot用マシン>      # 初回は /etc/default/minecraft-ai-town ができるので MC_HOST を書き換えて再実行
ssh root@<bot用マシン> /opt/minecraft-ai-town/bin/status   # 状態・街・最後の判断・最近の出来事
ssh root@<bot用マシン> /opt/minecraft-ai-town/bin/decisions -f   # 判断係の判断（見た状況・選択肢・確率）を流し続ける
ssh root@<bot用マシン> cat /var/lib/minecraft-ai-town/memory/diary/$(date +%F).md   # 考える係の日記
```

判断係（Qwen3.5-4B）も動かす場合は、先に bot 用マシンで `scripts/setup-llm.sh` を実行する（llama.cpp のビルドとモデルのダウンロード。数分かかる）。

今の bot ができること: 接続・再接続、戦闘と逃走、自動で食事と防具、夜は穴を掘って避難、石の道具までの決め打ちの手順、そのあとは判断係が選ぶ行動（木を切る・石を掘る・狩り・家を建てる・苗木を植える・チェストにしまう・家に戻る・探検）、チャットのお願い（`来て` `止まって` `再開` `状況`）。

## しくみ（概要）

AI の仕事を速さで3段に分ける。

| 段 | 担当 | 速さ | やること |
|---|---|---|---|
| 反射 | ふつうのコード（Mineflayer プラグイン） | ミリ秒 | 戦闘・逃走・食事・防具・夜の避難 |
| 判断 | 2択／選択式の判断モデル（logit を直接読む方式） | 〜1秒 | 次に何をするか |
| 戦略 | 文章を書ける LLM + Web（夜だけ） | 数分〜数時間 | Wiki を読み、目標・街の計画・日記を書く |

人間は直接見なくてもよいように、出来事ログ・現在の状態・日記をファイルに残す。

## 接続先として想定するサーバー

- Minecraft Java Edition **1.21.4**（Mineflayer がまともに動く版。26.1.x では移動がサーバーに拒否され続けた）
- `online-mode=false`（bot はアカウントなしで接続する）、bot の名前はホワイトリストに登録済み
- 難易度イージー、`keepInventory` オン
- 接続先は設定ファイル（`host` / `port`）で渡す。特定のサーバー構成には依存しない

`online-mode=false` のサーバーは名前を名乗るだけで誰でも入れるので、インターネットに公開しないこと。
