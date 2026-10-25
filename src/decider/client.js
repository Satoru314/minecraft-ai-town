// 判断係: llama.cpp サーバー（llama-server）に「どの選択肢にするか」を聞く。
// 文章は生成させず、選択肢に付けた記号（A, B, C…）が最初の1トークンとして出る確率を読む（Jev / SemIf と同じ考え方）。
const LETTERS = 'ABCDEFGHIJKLMNOP'
const SYSTEM = 'あなたは Minecraft のサバイバルで街を作る住人の「判断係」です。' +
  '目標と状況を読み、質問に対して最も良い選択肢を1つ選び、その記号1文字だけで答えます。'

export function createDecider ({ url, timeoutMs = 30000 }) {
  async function choose ({ goal, situation, question, options }) {
    if (options.length > LETTERS.length) throw new Error('too many options')
    const lines = options.map((o, i) => `${LETTERS[i]}: ${o.label}`)
    const user = `目標: ${goal}\n\n状況:\n${situation}\n\n${question}\n${lines.join('\n')}`
    // Qwen3.5 の ChatML。<think> を空にして、考える過程を飛ばしてすぐ答えさせる
    const prompt = `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n` +
      '<|im_start|>assistant\n<think>\n\n</think>\n\n'

    const started = Date.now()
    const res = await fetch(`${url}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, n_predict: 1, n_probs: 20, temperature: 0, cache_prompt: true }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) throw new Error(`decider HTTP ${res.status}`)
    const data = await res.json()

    const top = data.completion_probabilities?.[0]?.top_logprobs ?? []
    const raw = options.map((_, i) => {
      const hit = top.find((t) => t.token.trim() === LETTERS[i])
      return hit ? Math.exp(hit.logprob) : 0
    })
    const total = raw.reduce((a, b) => a + b, 0)
    if (total === 0) throw new Error(`no option letter in the top tokens (${top.slice(0, 3).map((t) => t.token).join(',')})`)

    let best = 0
    raw.forEach((p, i) => { if (p > raw[best]) best = i })
    // 確率は「表示した選択肢の中で」正規化した値。自信の度合いとしては校正されていない
    const probs = Object.fromEntries(options.map((o, i) => [o.key, Number((raw[i] / total).toFixed(3))]))
    return { choice: options[best].key, probs, ms: Date.now() - started, promptTokens: data.timings?.prompt_n }
  }

  return { choose }
}
