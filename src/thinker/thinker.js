// 考える係: 数分おき、または何か起きたときに、ローカル LLM が文章で振り返り、
// 方針・教訓・覚えておくこと・ほしい能力・つぶやきを決める。結果は記憶領域に残し、判断係の状況説明にも入る。
const THINK_EVERY_MS = 2 * 60 * 1000
const SOON_MS = 20 * 1000
const STATS_HOURS = 3

const SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string', maxLength: 80 },
    focus: { type: 'string', maxLength: 120 },
    add_lessons: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 2 },
    remove_lessons: { type: 'array', items: { type: 'integer' }, maxItems: 3 },
    add_facts: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 2 },
    wishes: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 2 },
    // 新しい建物の設計（設計しないときは name を空文字にする）
    design: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 20 },
        width: { type: 'integer' },
        depth: { type: 'integer' },
        height: { type: 'integer' },
        wall: { type: 'string', enum: ['cobblestone', 'planks', 'log'] },
        roof: { type: 'string', enum: ['cobblestone', 'planks', 'log'] },
        pillar: { type: 'string', enum: ['none', 'cobblestone', 'planks', 'log'] },
        windows: { type: 'boolean' }
      },
      required: ['name', 'width', 'depth', 'height', 'wall', 'roof', 'pillar', 'windows']
    }
  },
  required: ['say', 'focus', 'add_lessons', 'remove_lessons', 'add_facts', 'wishes', 'design']
}

function hhmm (iso) {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })
}

// 前回考えてから起きたことを、短い日本語の行にまとめる
function summarizeEvents (events) {
  const lines = []
  const chosen = {}
  for (const e of events) {
    const t = hhmm(e.t)
    switch (e.type) {
      case 'death': lines.push(`${t} 死んだ: ${e.cause ?? '原因不明'}`); break
      case 'build': lines.push(`${t} 建てた: ${e.what}`); break
      case 'repair': lines.push(`${t} 家を直した（${e.placed}ブロック）`); break
      case 'hunt': lines.push(`${t} ${e.target} を狩った（食べ物 +${e.gained}）`); break
      case 'kill': lines.push(`${t} ${e.target} を倒した`); break
      case 'plant': lines.push(`${t} 苗木を${e.count}本植えた`); break
      case 'store': lines.push(`${t} チェストに${e.moved}個しまった`); break
      case 'sleep': lines.push(`${t} ベッドで寝た`); break
      case 'stay_home': lines.push(`${t} 家の中で夜を過ごした`); break
      case 'shelter': lines.push(`${t} 穴を掘ってこもった`); break
      case 'flee': lines.push(`${t} ${e.from} から逃げた（HP ${Math.round(e.health)}）`); break
      case 'build_site_not_found': lines.push(`${t} 家を建てる平らな場所が見つからなかった`); break
      case 'store_failed': lines.push(`${t} しまうのに失敗: ${e.reason}`); break
      case 'task_error': lines.push(`${t} ${e.task} に失敗: ${String(e.error).slice(0, 60)}`); break
      case 'decision': chosen[e.choice] = (chosen[e.choice] ?? 0) + 1; break
    }
  }
  const counts = Object.entries(chosen).map(([k, n]) => `${k}×${n}`).join('、')
  if (counts) lines.push(`選んだ行動: ${counts}`)
  // 多すぎると読むのに時間がかかるので、新しい方から
  return lines.slice(-25)
}

// 行動ごとの成功率と死因（直近 STATS_HOURS 時間）
function summarizeStats (events) {
  const steps = {}
  const deaths = {}
  for (const e of events) {
    if (e.type === 'step') {
      const s = steps[e.key] ?? (steps[e.key] = { ok: 0, n: 0 })
      s.n++
      if (e.ok) s.ok++
    } else if (e.type === 'death') {
      const cause = (e.cause ?? '不明').replace(/^\S+ /, '')
      deaths[cause] = (deaths[cause] ?? 0) + 1
    }
  }
  const stepLine = Object.entries(steps).sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `${k} ${v.ok}/${v.n}`).join('、')
  const deathLine = Object.entries(deaths).map(([k, n]) => `${k}×${n}`).join('、')
  return [stepLine && `行動の成功/回数: ${stepLine}`, deathLine && `死因: ${deathLine}`].filter(Boolean)
}

export function createThinker ({ bot, ctx, rec, memory, llmUrl, goal, situation, abilities, designs, normalizeSpec }) {
  let running = false
  let lastAt = new Date().toISOString()
  let timer = null
  const heard = []

  function buildPrompt () {
    const m = memory.data
    const numbered = (list) => list.length ? list.map((x, i) => `${i + 1}. ${x}`).join('\n') : '（まだない）'
    const events = summarizeEvents(rec.readSince(lastAt))
    const voices = heard.splice(0).map((h) => `- ${h.from}: 「${h.text}」`)
    const system = `あなたは Minecraft のサバイバルワールドで暮らす住人「${bot.username}」の心です。` +
      '体（移動・戦闘・採掘・建築）は別の仕組みが動かしていて、あなたは数分おきに状況を振り返ります。' +
      'やることは、これからの方針を決めること、経験から教訓を学んで記憶に残すこと、覚えておきたい場所や事実を残すこと、' +
      '今の体にはできないけれど、できるようになりたいことを書くこと、そして近くの人に一言つぶやくことです。' +
      '話しかけられていたら、つぶやきでその人に答えてください。' +
      '考える過程も必ず日本語で、要点だけを箇条書き10行以内にまとめてください（状況の書き写しや英語の分析はしない）。'
    const user = [
      `# 目標\n${goal()}`,
      `# 今の状況\n${situation()}`,
      `# 体が今できること\n${abilities().map((a) => `- ${a}`).join('\n')}`,
      `# 記憶\n今の方針: ${m.focus || '（まだない）'}\n\n教訓:\n${numbered(m.lessons)}\n\n覚えている場所・事実:\n${numbered(m.facts)}\n\nできるようになりたいこと:\n${numbered(m.wishes)}`,
      `# 前回考えてから起きたこと\n${events.length ? events.map((l) => `- ${l}`).join('\n') : '（特になし）'}`,
      `# ここ${STATS_HOURS}時間の成績\n${summarizeStats(rec.readSince(new Date(Date.now() - STATS_HOURS * 3600 * 1000).toISOString())).join('\n') || '（まだない）'}`,
      `# 建てられる建物の設計図\n${designs().map((d) => `- ${d.name}: ${d.width}×${d.depth}、高さ${d.height}、壁=${d.wall}、屋根=${d.roof}、柱=${d.pillar ?? 'なし'}、窓=${d.windows ? 'あり' : 'なし'}`).join('\n')}`,
      voices.length ? `# 聞こえた声\n${voices.join('\n')}` : null,
      '# お願い\n振り返って、次を決めてください。\n' +
        '- say: 近くの人へのつぶやき（1文、80文字以内）\n' +
        '- focus: これからしばらくの方針。目標（大きな街）に近づくことを、体が今できることを使って具体的に（例「区画 0,-1 のならしを終え、丸石を集めて大きい家を建てる」）。もう達成したこと（ベッドがあるのにベッドを作る、など）は方針にしない\n' +
        '- add_lessons: 新しく学んだ教訓（なければ空）\n' +
        '- remove_lessons: もう要らない・間違っていた教訓の番号（なければ空）\n' +
        '- add_facts: 覚えておく場所や事実（なければ空）\n' +
        '- wishes: 今の体にはできないが、できるようになりたいこと（なければ空）\n' +
        '- design: 街に新しく欲しい建物があれば設計する（幅・奥行き 5〜11、高さ 3〜6、材料は cobblestone / planks / log、柱は none も可）。' +
        '今の設計図で足りていれば name を空にする'
    ].filter(Boolean).join('\n\n')
    return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n- `
  }

  async function complete (body) {
    const res = await fetch(`${llmUrl}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cache_prompt: true, ...body }),
      signal: AbortSignal.timeout(240000)
    })
    if (!res.ok) throw new Error(`thinker HTTP ${res.status}`)
    return res.json()
  }

  async function think (trigger) {
    if (running || !bot.entity) return
    running = true
    const started = Date.now()
    const since = new Date().toISOString()
    try {
      const prompt = buildPrompt()
      // 1. 考える（<think> の中で自由に）
      // 小さいモデルは同じ行を繰り返しがちなので、繰り返しに罰を与え、同じ行は1回だけ残す
      const t1 = await complete({ prompt, n_predict: 400, temperature: 0.7, repeat_penalty: 1.2, repeat_last_n: 256, presence_penalty: 0.6, stop: ['</think>'] })
      const seen = new Set()
      const thought = ('- ' + t1.content).split('\n').map((l) => l.trimEnd())
        .filter((l) => { if (!l.trim()) return false; if (seen.has(l.trim())) return false; seen.add(l.trim()); return true })
        .join('\n').trim()
      // 2. 決めたことを JSON で書く
      const t2 = await complete({ prompt: prompt + thought + '\n</think>\n\n', n_predict: 400, temperature: 0.3, json_schema: SCHEMA })
      const out = JSON.parse(t2.content)

      memory.data.focus = out.focus.trim() || memory.data.focus
      memory.remove('lessons', out.remove_lessons)
      memory.add('lessons', out.add_lessons)
      memory.add('facts', out.add_facts)
      memory.add('wishes', out.wishes)
      let designed = null
      if (out.design?.name?.trim()) {
        designed = normalizeSpec({ ...out.design, pillar: out.design.pillar === 'none' ? null : out.design.pillar })
        memory.addDesign(designed)
      }
      memory.data.thoughts++
      memory.save()
      memory.appendDiary([
        `## ${hhmm(since)}（${trigger}）`,
        '',
        thought,
        '',
        `- つぶやき: ${out.say}`,
        `- 方針: ${out.focus}`,
        out.add_lessons.length ? `- 学んだこと: ${out.add_lessons.join(' / ')}` : null,
        out.wishes.length ? `- できるようになりたい: ${out.wishes.join(' / ')}` : null,
        designed ? `- 設計した建物: ${designed.name}（${designed.width}×${designed.depth}、高さ${designed.height}）` : null,
        ''
      ].filter((l) => l !== null).join('\n'))

      const say = out.say.replace(/\s+/g, ' ').trim().slice(0, 100)
      if (say) bot.chat(say)
      lastAt = since
      rec.event('thought', {
        trigger,
        say,
        focus: out.focus,
        addLessons: out.add_lessons,
        removeLessons: out.remove_lessons,
        addFacts: out.add_facts,
        wishes: out.wishes,
        design: designed,
        ms: Date.now() - started,
        promptTokens: t1.timings?.prompt_n,
        thoughtTokens: t1.timings?.predicted_n
      })
    } catch (err) {
      rec.event('thought_failed', { trigger, error: err.message, ms: Date.now() - started })
    } finally {
      running = false
    }
  }

  // 何か起きたら少し待ってから考える（立て続けの出来事をまとめるため）
  let soon = null
  function thinkSoon (trigger) {
    if (soon) return
    soon = setTimeout(() => { soon = null; think(trigger) }, SOON_MS)
  }

  return {
    start () {
      timer = setInterval(() => think('定期'), THINK_EVERY_MS)
      setTimeout(() => think('起動'), 30000)
      bot.once('end', () => { clearInterval(timer); clearTimeout(soon) })
    },
    hear (from, text) {
      heard.push({ from, text })
      if (heard.length > 10) heard.shift()
      thinkSoon('話しかけられた')
    },
    thinkSoon
  }
}
