// 街の区画割り: 中心から 16 ブロックごとの碁盤の目に幅3の道を通し、道に囲まれた 13x13 を区画にする。
// 区画はそれぞれ、その土地のふつうの高さ（地面の高さの中央値）にならしてから建物を建てる。
// 道は地形に沿って通す（上にあるものを片付けて、土の道にする）。
import { Vec3 } from 'vec3'

export const STEP = 16
export const PLOT = 13
const MAX_FILL_DEPTH = 4 // これより深い穴がある区画・道は飛ばす
const MAX_CUT_HEIGHT = 8 // 地面の上、この高さまでは片付ける（木も含む）
const MAX_PLOT_WORK = 800
const UNSUITABLE = /water|lava/

// 中心がまだなければ、最初の家の前を中心にする
export function ensureCenter (town) {
  if (town.data.center || !town.data.home) return town.data.center
  const h = town.data.home
  town.data.center = { x: h.x, z: h.z }
  town.data.level = h.y - 1
  town.data.plots = town.data.plots ?? {}
  town.data.roads = town.data.roads ?? {}
  town.save()
  return town.data.center
}

export function plotBounds (town, i, j) {
  const c = town.data.center
  const x0 = c.x + 2 + STEP * i
  const z0 = c.z + 2 + STEP * j
  return { x0, z0, x1: x0 + PLOT - 1, z1: z0 + PLOT - 1 }
}

// 区画の一覧（中心に近い順）
export function plotsByDistance (town, radius = 3) {
  const list = []
  for (let i = -radius; i < radius; i++) {
    for (let j = -radius; j < radius; j++) {
      const id = `${i},${j}`
      const rec = town.data.plots[id]
      list.push({ id, i, j, ...plotBounds(town, i, j), state: rec?.state ?? 'empty', level: rec?.level ?? town.data.level })
    }
  }
  return list.sort((a, b) => (Math.abs(a.i + 0.5) + Math.abs(a.j + 0.5)) - (Math.abs(b.i + 0.5) + Math.abs(b.j + 0.5)))
}

function overlapsStructure (town, b) {
  return town.data.structures.some((s) => s.origin.x <= b.x1 && s.origin.x + s.size.x - 1 >= b.x0 &&
    s.origin.z <= b.z1 && s.origin.z + s.size.z - 1 >= b.z0)
}

function surfaceY (bot, x, z, level, above = MAX_CUT_HEIGHT + 4, below = MAX_FILL_DEPTH + 2) {
  for (let y = level + above; y >= level - below; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return null
    if (b.boundingBox === 'block' && !/leaves|log/.test(b.name)) return { y, block: b }
    if (UNSUITABLE.test(b.name)) return { y, block: b }
  }
  return null
}

// 範囲の地面の高さの中央値（見えていない・水が多いなどで決められなければ null）
export function groundLevel (bot, town, b) {
  const ys = []
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      const g = surfaceY(bot, x, z, town.data.level, 30, 20)
      if (!g) return null
      if (!UNSUITABLE.test(g.block.name)) ys.push(g.y)
    }
  }
  if (ys.length < (b.x1 - b.x0 + 1) * (b.z1 - b.z0 + 1) * 0.8) return null
  ys.sort((a, b) => a - b)
  return ys[Math.floor(ys.length / 2)]
}

// 長方形の範囲を level の高さにならすための作業（削るブロック・埋める場所）。向いていなければ null
export function earthwork (bot, town, b, level = b.level ?? town.data.level) {
  const cut = []
  const fill = []
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      const g = surfaceY(bot, x, z, level)
      if (!g || UNSUITABLE.test(g.block.name)) return null
      if (g.y < level - MAX_FILL_DEPTH) return null
      for (let y = g.y + 1; y <= level; y++) fill.push(new Vec3(x, y, z))
      for (let y = level + 1; y <= level + MAX_CUT_HEIGHT; y++) {
        const above = bot.blockAt(new Vec3(x, y, z))
        if (!above) return null
        if (above.name === 'air' || above.name === 'cave_air') continue
        if (UNSUITABLE.test(above.name)) return null
        cut.push(above.position)
      }
    }
  }
  return { cut, fill }
}

// 次にならす区画: ならしかけ → 空いている区画（中心に近い順）。重すぎる・向かない区画は飛ばす
export function nextPlotToLevel (bot, town) {
  for (const p of plotsByDistance(town)) {
    if (p.state === 'leveling') return p
  }
  for (const p of plotsByDistance(town)) {
    if (p.state !== 'empty') continue
    if (overlapsStructure(town, p)) {
      town.data.plots[p.id] = { state: 'occupied' }
      continue
    }
    const level = groundLevel(bot, town, p)
    if (level === null) continue // まだ見えていない、または水が多い
    p.level = level
    const work = earthwork(bot, town, p)
    if (!work) continue // まだ見えていない、または水などで向かない（記録はしない。あとで見えれば候補になる）
    if (work.cut.length + work.fill.length > MAX_PLOT_WORK) {
      town.data.plots[p.id] = { state: 'skipped', reason: 'too much work' }
      continue
    }
    town.data.plots[p.id] = { state: 'empty', level }
    return p
  }
  return null
}

export function readyPlots (town) {
  if (!town.data.center) return []
  return plotsByDistance(town).filter((p) => p.state === 'leveled')
}

// 道の区間。h は x 方向（z = 中心 + 16b の線）、v は z 方向（x = 中心 + 16a の線）
export function roadBounds (town, key) {
  const c = town.data.center
  const [dir, rest] = key.split(':')
  const [a, b] = rest.split(',').map(Number)
  if (dir === 'h') return { x0: c.x + STEP * a, x1: c.x + STEP * (a + 1), z0: c.z + STEP * b - 1, z1: c.z + STEP * b + 1 }
  return { x0: c.x + STEP * a - 1, x1: c.x + STEP * a + 1, z0: c.z + STEP * b, z1: c.z + STEP * (b + 1) }
}

// 道の作業: 各列の地面の上（3段）にあるものを片付ける。地面の高さはそのまま（地形に沿う）。
// 見えていなければ { unseen: true }、水などで向かなければ null
export function roadwork (bot, town, b) {
  const cut = []
  const surface = []
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      // 建物の敷地は通らない（その列は手をつけない）
      if (overlapsStructure(town, { x0: x, x1: x, z0: z, z1: z })) continue
      const g = surfaceY(bot, x, z, town.data.level, 30, 20)
      if (!g) return { unseen: true }
      if (UNSUITABLE.test(g.block.name)) return null
      surface.push(g.block.position)
      for (let y = g.y + 1; y <= g.y + 3; y++) {
        const above = bot.blockAt(new Vec3(x, y, z))
        if (!above) return { unseen: true }
        if (above.boundingBox === 'block' || /log|leaves/.test(above.name)) cut.push(above.position)
      }
    }
  }
  return { cut, fill: [], surface }
}

// 次に作る道: 中心の交差点か、できている道につながっている区間のうち、中心に近いもの
export function nextRoad (town, radius = 3) {
  const done = new Set(Object.entries(town.data.roads).filter(([, r]) => r.state === 'done').map(([k]) => k))
  const skipped = new Set(Object.entries(town.data.roads).filter(([, r]) => r.state === 'skipped').map(([k]) => k))
  const ends = (key) => {
    const [dir, rest] = key.split(':')
    const [a, b] = rest.split(',').map(Number)
    return dir === 'h' ? [`${a},${b}`, `${a + 1},${b}`] : [`${a},${b}`, `${a},${b + 1}`]
  }
  const reached = new Set(['0,0'])
  for (const k of done) for (const e of ends(k)) reached.add(e)

  const candidates = []
  for (let a = -radius; a < radius; a++) {
    for (let b = -radius; b <= radius; b++) {
      for (const key of [`h:${a},${b}`, `v:${b},${a}`]) {
        if (done.has(key) || skipped.has(key)) continue
        if (!ends(key).some((e) => reached.has(e))) continue
        const [ea] = ends(key)
        const [x, z] = ea.split(',').map(Number)
        candidates.push({ key, dist: Math.abs(x) + Math.abs(z) })
      }
    }
  }
  candidates.sort((p, q) => p.dist - q.dist)
  return candidates[0]?.key ?? null
}

export function townSummary (town) {
  if (!town.data.center) return null
  const plots = Object.values(town.data.plots ?? {})
  const count = (st) => plots.filter((p) => p.state === st).length
  const roads = Object.values(town.data.roads ?? {}).filter((r) => r.state === 'done').length
  return `街の区画: ならし済み ${count('leveled')}、建物あり ${count('built')}、ならし中 ${count('leveling')}、道 ${roads}区間`
}
