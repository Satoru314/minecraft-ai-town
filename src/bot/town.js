// 街の記録（data/town.json）: 家の場所、建てたもの、植えた苗木の数。再起動しても引き継ぐ。
import fs from 'node:fs'
import path from 'node:path'

export function loadTown (dataDir) {
  const file = path.join(dataDir, 'town.json')
  const data = { home: null, structures: [], saplingsPlanted: 0, chest: null }
  try {
    Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {}

  return {
    data,
    save () {
      fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2))
      fs.renameSync(file + '.tmp', file)
    },
    // 建物の敷地（周り2マスの余白込み）に入っているか
    occupied (x, z) {
      return data.structures.some((s) => x >= s.origin.x - 2 && x <= s.origin.x + s.size.x + 1 &&
        z >= s.origin.z - 2 && z <= s.origin.z + s.size.z + 1)
    }
  }
}
