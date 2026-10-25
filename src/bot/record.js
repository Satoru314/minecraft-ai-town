// 記録: data/events.jsonl（出来事を1行ずつ追記）と data/state.json（現在の状態を上書き）
import fs from 'node:fs'
import path from 'node:path'

export function createRecorder (dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const eventsPath = path.join(dataDir, 'events.jsonl')
  const statePath = path.join(dataDir, 'state.json')

  return {
    event (type, detail = {}) {
      const line = JSON.stringify({ t: new Date().toISOString(), type, ...detail })
      fs.appendFileSync(eventsPath, line + '\n')
      console.log(line)
    },

    writeState (state) {
      const tmp = statePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, statePath)
    },

    // 指定時刻より後の出来事（ファイルの末尾 512KB だけ読む）
    readSince (iso) {
      let text
      try {
        const fd = fs.openSync(eventsPath, 'r')
        const size = fs.fstatSync(fd).size
        const len = Math.min(size, 512 * 1024)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, size - len)
        fs.closeSync(fd)
        text = buf.toString('utf8')
      } catch {
        return []
      }
      const out = []
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue
        try {
          const e = JSON.parse(line)
          if (e.t > iso) out.push(e)
        } catch {}
      }
      return out
    },

    readState () {
      try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8'))
      } catch {
        return {}
      }
    }
  }
}
