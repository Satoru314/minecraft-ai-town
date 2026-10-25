// 記憶領域（data/memory/）: 考える係が読み書きする長期の記憶と日記。再起動しても残る。
import fs from 'node:fs'
import path from 'node:path'

const LIMITS = { lessons: 20, facts: 20, wishes: 10, designs: 8 }

export function loadMemory (dataDir) {
  const dir = path.join(dataDir, 'memory')
  fs.mkdirSync(path.join(dir, 'diary'), { recursive: true })
  const file = path.join(dir, 'memory.json')
  const data = { focus: '', lessons: [], facts: [], wishes: [], designs: [], thoughts: 0, updatedAt: null }
  try {
    Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {}

  function save () {
    data.updatedAt = new Date().toISOString()
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2))
    fs.renameSync(file + '.tmp', file)
  }

  // 同じ内容は重ねず、上限を超えたら古いものから忘れる
  function add (kind, items) {
    for (const raw of items ?? []) {
      // 「4. 〜」のように番号を付けて書いてくることがあるので外す
      const text = String(raw).trim().replace(/^\d+\s*[.．、)）]\s*/, '')
      if (!text || data[kind].includes(text)) continue
      data[kind].push(text)
    }
    while (data[kind].length > LIMITS[kind]) data[kind].shift()
  }

  function remove (kind, numbers) {
    // 番号は 1 始まり（プロンプトで見せた番号）
    const drop = new Set((numbers ?? []).map((n) => Number(n) - 1))
    data[kind] = data[kind].filter((_, i) => !drop.has(i))
  }

  // 自分で設計した建物。同じ名前なら上書き、上限を超えたら古いものから消す
  function addDesign (spec) {
    data.designs = data.designs.filter((d) => d.name !== spec.name)
    data.designs.push(spec)
    while (data.designs.length > LIMITS.designs) data.designs.shift()
  }

  function appendDiary (text) {
    const day = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(path.join(dir, 'diary', `${day}.md`), text + '\n')
  }

  return { data, save, add, remove, addDesign, appendDiary }
}
