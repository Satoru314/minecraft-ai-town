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

// 設計図は「データ」（spec）で持ち、ブロックの並びはここで組み立てる。考える係が新しい spec を設計して足せるようにするため。
// spec: { name, width, depth, height（壁の高さ）, wall, roof, pillar（四隅の柱。なければ null）, windows }
// 材料の種類（kind）は cobblestone / planks / log のどれか
export const MATERIALS = ['cobblestone', 'planks', 'log']
export const SPEC_LIMITS = { width: [5, 11], depth: [5, 11], height: [3, 6] }

export const SMALL_HOUSE = { name: '小さい家', width: 5, depth: 5, height: 3, wall: 'cobblestone', roof: 'planks', pillar: null, windows: false }
export const BUILTIN_SPECS = [
  SMALL_HOUSE,
  { name: '大きい家', width: 7, depth: 7, height: 4, wall: 'cobblestone', roof: 'planks', pillar: 'log', windows: true },
  { name: '倉庫', width: 9, depth: 7, height: 4, wall: 'planks', roof: 'planks', pillar: 'log', windows: false },
  { name: '集会所', width: 11, depth: 9, height: 5, wall: 'cobblestone', roof: 'planks', pillar: 'log', windows: true }
]

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)))

// 考える係が書いた spec を、建てられる範囲に収める
export function normalizeSpec (spec) {
  const pickMat = (m, fallback) => (MATERIALS.includes(m) ? m : fallback)
  return {
    name: String(spec.name || '建物').slice(0, 20),
    width: clamp(spec.width, SPEC_LIMITS.width),
    depth: clamp(spec.depth, SPEC_LIMITS.depth),
    height: clamp(spec.height, SPEC_LIMITS.height),
    wall: pickMat(spec.wall, 'cobblestone'),
    roof: pickMat(spec.roof, 'planks'),
    pillar: spec.pillar ? pickMat(spec.pillar, 'log') : null,
    windows: !!spec.windows
  }
}

// 正面（z=0 側）の真ん中に扉の穴（高さ2）、平らな屋根。窓は高さ2段目に、角を除いて1つおき
export function specToBlueprint (spec) {
  const { width: w, depth: d, height: h } = spec
  const doorX = Math.floor(w / 2)
  const blocks = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        const edgeX = x === 0 || x === w - 1
        const edgeZ = z === 0 || z === d - 1
        if (!edgeX && !edgeZ) continue
        if (x === doorX && z === 0 && y < 2) continue
        const corner = edgeX && edgeZ
        if (corner && spec.pillar) { blocks.push({ x, y, z, kind: spec.pillar }); continue }
        if (spec.windows && y === 1 && !corner && (edgeX ? z : x) % 2 === 0 && !(x === doorX && z === 0)) continue
        blocks.push({ x, y, z, kind: spec.wall })
      }
    }
  }
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) blocks.push({ x, y: h, z, kind: spec.roof })
  return {
    type: spec.name,
    spec,
    size: { x: w, y: h + 1, z: d },
    doorAt: { x: doorX, z: 0 },
    door: { x: doorX, z: -1 },
    interior: { x: doorX, z: Math.floor(d / 2) },
    blocks
  }
}

// 古い記録（type: 'house'、spec なし）は小さい家として扱う
export function blueprintFor (structure) {
  return specToBlueprint(structure.spec ?? SMALL_HOUSE)
}

export function houseBlueprint () {
  return specToBlueprint(SMALL_HOUSE)
}

export function materialsNeeded (blueprint) {
  const need = {}
  for (const b of blueprint.blocks) need[b.kind] = (need[b.kind] ?? 0) + 1
  return need
}

// 材料の種類に合う持ち物を1つ選ぶ（古い kind 名 wall / roof も受け付ける）
export function pickMaterial (bot, kind) {
  const items = bot.inventory.items()
  const k = kind === 'wall' ? 'cobblestone' : kind === 'roof' ? 'planks' : kind
  if (k === 'cobblestone') return items.find((i) => i.name === 'cobblestone') ?? items.find((i) => i.name === 'cobbled_deepslate')
  if (k === 'planks') return items.find((i) => i.name.endsWith('_planks'))
  if (k === 'log') return items.find((i) => /_(log|stem)$/.test(i.name) && !i.name.startsWith('stripped_'))
  return null
}

export function materialCount (bot, kind) {
  const items = bot.inventory.items()
  const match = kind === 'cobblestone'
    ? (i) => i.name === 'cobblestone' || i.name === 'cobbled_deepslate'
    : kind === 'planks' ? (i) => i.name.endsWith('_planks') : (i) => /_(log|stem)$/.test(i.name) && !i.name.startsWith('stripped_')
  return items.filter(match).reduce((n, i) => n + i.count, 0)
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
  // 自分の足元（立っている列の下）を掘ると、落ちる途中の位置がサーバーと食い違って引き戻され続ける。
  // その列は後回しにし、周りを削るうちに離れてから掘る
  const queue = [...site.cut].sort((a, b) => b.y - a.y)
  const deferred = new Map()
  while (queue.length) {
    const p = queue.shift()
    if (shouldStop()) return false
    const b = bot.blockAt(p)
    if (!b || REPLACEABLE.has(b.name)) continue
    const feet = bot.entity.position.floored()
    if (p.x === feet.x && p.z === feet.z && p.y < feet.y) {
      const key = p.toString()
      const n = deferred.get(key) ?? 0
      if (n < 3) {
        deferred.set(key, n + 1)
        queue.push(p)
        if (queue.length === 1) {
          // 残りがこれだけなら、横にずれてから掘る
          await bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalNearXZ(p.x, p.z, 1))).catch(() => {})
        }
        continue
      }
    }
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
