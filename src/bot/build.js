// 建築: 設計図（ブロックの相対座標と種類）どおりに置いていく。
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { pos } from './util.js'

const { goals } = pathfinderPkg

// 上に置いてかまわない（掘って置き換えてよい）ブロック
const REPLACEABLE = new Set(['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip',
  'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'snow', 'sweet_berry_bush'])
const BAD_GROUND = /leaves|log|water|lava|ice|sand|gravel|_planks|glass/

// 5x5、壁の高さ3、正面（z=0 側）の真ん中に扉の穴、平らな屋根
export function houseBlueprint () {
  const blocks = []
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 5; x++) {
      for (let z = 0; z < 5; z++) {
        const edge = x === 0 || x === 4 || z === 0 || z === 4
        if (!edge) continue
        if (x === 2 && z === 0 && y < 2) continue
        blocks.push({ x, y, z, kind: 'wall' })
      }
    }
  }
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) blocks.push({ x, y: 3, z, kind: 'roof' })
  return { type: 'house', size: { x: 5, y: 4, z: 5 }, door: { x: 2, z: -1 }, blocks }
}

export function materialsNeeded (blueprint) {
  const need = {}
  for (const b of blueprint.blocks) need[b.kind] = (need[b.kind] ?? 0) + 1
  return need
}

// その列でいちばん高い固いブロック（葉は除く）= 地表。地下にいても地表を基準に探せるようにする
function surface (bot, x, z, fromY, toY) {
  for (let y = fromY; y >= toY; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (b && b.boundingBox === 'block' && !/leaves/.test(b.name)) return { y, block: b }
  }
  return null
}

const NOT_CLEARABLE = /log|leaves|water|lava|chest|bed|door|_planks|glass|furnace|crafting_table/

// origin（地面の1つ上）に設計図を置くとき、地面をならすのに要る作業を調べる。
// 地面は origin.y - 1 の高さ ±1 段まで。高いところは削り（cut）、低いところは土で埋める（fill）
function analyzeSite (bot, town, blueprint, ox, baseY, oz, at) {
  const { x: sx, y: sy, z: sz } = blueprint.size
  const cut = []
  const fill = []
  // 扉の前の1列も含めて調べる
  for (let x = -1; x <= sx; x++) {
    for (let z = -1; z <= sz; z++) {
      if (town.occupied(ox + x, oz + z)) return null
      const g = at(ox + x, oz + z)
      if (!g || Math.abs(g.y - baseY) > 1 || BAD_GROUND.test(g.block.name)) return null
      if (g.y === baseY - 1) fill.push(new Vec3(ox + x, baseY, oz + z))
      for (let y = 1; y <= sy; y++) {
        const b = bot.blockAt(new Vec3(ox + x, baseY + y, oz + z))
        if (!b) return null
        if (REPLACEABLE.has(b.name)) continue
        if (NOT_CLEARABLE.test(b.name)) return null
        cut.push(b.position)
      }
    }
  }
  return { cut, fill }
}

function heightMap (bot, center) {
  const top = Math.min(Math.floor(center.y) + 48, 300)
  const bottom = Math.floor(center.y) - 16
  const heights = new Map()
  return (x, z) => {
    const key = `${x},${z}`
    if (!heights.has(key)) heights.set(key, surface(bot, x, z, top, bottom))
    return heights.get(key)
  }
}

// 近くで家を建てられる場所を探す。地面をならす作業（削る・埋める）が maxWork 個以内の候補から、作業が少なく近いものを選ぶ。
// 返り値: { origin（南西の角、地面の1つ上）, cut, fill } または null
export function findBuildSite (bot, town, blueprint, center, radius = 24, maxWork = 12) {
  const cx = Math.floor(center.x)
  const cz = Math.floor(center.z)
  const at = heightMap(bot, center)

  let best = null
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      const base = at(cx + dx, cz + dz)
      if (!base) continue
      const site = analyzeSite(bot, town, blueprint, cx + dx, base.y, cz + dz, at)
      if (!site) continue
      const work = site.cut.length + site.fill.length
      if (work > maxWork) continue
      const score = work * 4 + Math.sqrt(dx * dx + dz * dz)
      if (!best || score < best.score) best = { score, origin: new Vec3(cx + dx, base.y + 1, cz + dz), ...site }
    }
  }
  return best
}

// 地面をならす: 高い順に削ってから、低いところを埋める
export async function prepareSite (bot, rec, site, pickFill, shouldStop) {
  let cut = 0
  let filled = 0
  for (const p of [...site.cut].sort((a, b) => b.y - a.y)) {
    if (shouldStop()) return false
    const b = bot.blockAt(p)
    if (!b || REPLACEABLE.has(b.name)) continue
    try {
      await bot.pathfinder.goto(new goals.GoalLookAtBlock(p, bot.world, { reach: 4 }))
      if (bot.tool) await bot.tool.equipForBlock(b, {})
      await bot.dig(b)
      cut++
    } catch {}
  }
  for (const p of site.fill) {
    if (shouldStop()) return false
    const here = bot.blockAt(p)
    if (here && here.boundingBox === 'block') continue
    const below = bot.blockAt(p.offset(0, -1, 0))
    const item = pickFill()
    if (!below || below.boundingBox !== 'block' || !item) continue
    try {
      await bot.pathfinder.goto(new goals.GoalPlaceBlock(p, bot.world, { range: 4 }))
      await bot.equip(item, 'hand')
      await bot.placeBlock(below, new Vec3(0, 1, 0))
      filled++
    } catch {}
  }
  if (cut || filled) rec.event('earthwork', { cut, filled })
  return true
}

function findReference (bot, target) {
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const b = bot.blockAt(target.offset(dx, dy, dz))
    if (b && b.boundingBox === 'block') return { block: b, face: new Vec3(-dx, -dy, -dz) }
  }
  return null
}

// pickItem(kind) は置くアイテム（なければ null）を返す。shouldStop() が true になったら途中でやめる
export async function build (bot, rec, origin, blueprint, pickItem, shouldStop) {
  let remaining = blueprint.blocks.map((b) => ({ ...b, at: origin.offset(b.x, b.y, b.z) }))
  let placed = 0

  for (let pass = 0; pass < 6 && remaining.length > 0; pass++) {
    remaining.sort((a, b) => a.at.y - b.at.y || a.at.distanceTo(bot.entity.position) - b.at.distanceTo(bot.entity.position))
    const retry = []
    for (const t of remaining) {
      if (shouldStop()) return { placed, left: remaining.length, stopped: true }
      const current = bot.blockAt(t.at)
      if (current && current.boundingBox === 'block') continue
      const ref = findReference(bot, t.at)
      if (!ref) { retry.push(t); continue }
      const item = pickItem(t.kind)
      if (!item) return { placed, left: remaining.length, missing: t.kind }
      try {
        await bot.pathfinder.goto(new goals.GoalPlaceBlock(t.at, bot.world, { range: 4 }))
        if (current && current.name !== 'air' && current.name !== 'cave_air') await bot.dig(current)
        await bot.equip(item, 'hand')
        await bot.placeBlock(ref.block, ref.face)
        placed++
      } catch {
        retry.push(t)
      }
    }
    remaining = retry
  }
  if (remaining.length) rec.event('build_incomplete', { left: remaining.length, sample: pos(remaining[0].at) })
  return { placed, left: remaining.length }
}
