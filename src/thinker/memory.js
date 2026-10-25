// 記憶領域（data/memory/）: 考える係が読み書きする長期の記憶と日記。再起動しても残る。
import fs from 'node:fs'
import path from 'node:path'

const LIMITS = { lessons: 20, facts: 20, wishes: 10 }

export function loadMemory (dataDir) {
  const dir = path.join(dataDir, 'memory')
  fs.mkdirSync(path.join(dir, 'diary'), { recursive: true })
  const file = path.join(dir, 'memory.json')
  const data = { focus: '', lessons: [], facts: [], wishes: [], thoughts: 0, updatedAt: null }
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
      const text = String(raw).trim()
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

  function appendDiary (text) {
    const day = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(path.join(dir, 'diary', `${day}.md`), text + '\n')
  }

  return { data, save, add, remove, appendDiary }
}
