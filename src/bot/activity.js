// 行動: 判断モデルをつなぐまでの、決め打ちの手順。
// 木 → 作業台 → 木のツルハシ → 石 → 石の道具 → あとは木と石を貯め続ける。
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { countItem, countMatching, pos, sleep } from './util.js'
import { insideStructure, updateMovements } from './movement.js'
import { fellTree, isTreeBase } from './trees.js'
import { craftOnce } from './crafting.js'
import { BUILTIN_SPECS, SMALL_HOUSE, blueprintFor, build, findBuildSite, houseBlueprint, materialCount, materialsNeeded, normalizeSpec, pickMaterial, prepareSite, specToBlueprint } from './build.js'
import { PLOT, earthwork, ensureCenter, nextPlotToLevel, nextRoad, readyPlots, roadBounds, roadwork, townSummary } from './townplan.js'
import { foodCount, goHome, houses as finishedHouses, hunt, makeBed, makeDoor, plantSaplings, sleepInBed, stayHome, storeItems } from './skills.js'

const { goals } = pathfinderPkg

const LOG_RE = /^(?!stripped_).*_(log|stem)$/
const PLANKS_RE = /_planks$/

function logBlockIds (bot) {
  return Object.values(bot.registry.blocksByName).filter((b) => LOG_RE.test(b.name)).map((b) => b.id)
}

const COLLECT_TIMEOUT_MS = 45000
const STEP_TIMEOUT_MS = 90000
const EXPLORE_TIMEOUT_MS = 60000

// 時間内に終わらなければ、動きを止めて先に進む
async function withTimeout (bot, promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      // cancelTask() は返ってこないことがあるので待たない（待つと時間切れの処理ごと止まる）
      if (bot.collectBlock) bot.collectBlock.cancelTask().catch(() => {})
      // stop() は移動していないとフラグが残って次の移動を止めてしまうので、setGoal(null) で即座に解除する
      bot.pathfinder.setGoal(null)
      resolve('timeout')
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// 狙うもの: 木は根元の丸太（丸ごと切り倒す）、石は足場なしで届く深さのもの
function reachableFilter (bot, label) {
  const y = bot.entity.position.y
  if (label === 'log') return (p) => isTreeBase(bot, p) && !(bot.__town && insideStructure(bot.__town, p))
  return (p) => p.y <= y + 3 && p.y >= y - 8
}

// たどり着けなかった場所（8x8 の区画単位）。2回失敗した区画は10分間狙わない
const unreachable = new Map()
const UNREACHABLE_FORGET_MS = 10 * 60 * 1000
const cellOf = (p) => `${Math.floor(p.x / 8)},${Math.floor(p.z / 8)}`

function markUnreachable (p) {
  const cell = cellOf(p)
  const entry = unreachable.get(cell) ?? { fails: 0 }
  unreachable.set(cell, { fails: entry.fails + 1, at: Date.now() })
}

function isGivenUp (p) {
  const entry = unreachable.get(cellOf(p))
  if (!entry) return false
  if (Date.now() - entry.at > UNREACHABLE_FORGET_MS) {
    unreachable.delete(cellOf(p))
    return false
  }
  return entry.fails >= 2
}

// 近い順。ただし高低差は登り降りが大変なので3倍に数える
function findReachable (bot, blockIds, label, maxDistance) {
  const me = bot.entity.position
  const cost = (p) => p.distanceTo(me) + 3 * Math.abs(p.y - me.y)
  return bot.findBlocks({ matching: blockIds, maxDistance, count: 256 })
    .filter(reachableFilter(bot, label))
    .filter((p) => !isGivenUp(p))
    .sort((a, b) => cost(a) - cost(b))
}

async function collect (bot, ctx, rec, blockIds, label, want) {
  let found = findReachable(bot, blockIds, label, 96)
  if (found.length === 0) return explore(bot, rec, label)

  // 遠ければ、まず近くまで歩く
  const nearest = found[0]
  const distance = nearest.distanceTo(bot.entity.position)
  if (distance > 12) {
    rec.event('approach', { looking: label, to: pos(nearest), distance: Math.round(distance) })
    const result = await withTimeout(bot, bot.pathfinder.goto(new goals.GoalNear(nearest.x, nearest.y, nearest.z, 3)).catch((err) => err), EXPLORE_TIMEOUT_MS)
    if (result) {
      markUnreachable(nearest)
      rec.event('approach_failed', { reason: result === 'timeout' ? 'timeout' : result.message, target: pos(nearest), at: pos(bot.entity.position) })
      return false
    }
    found = findReachable(bot, blockIds, label, 16)
    if (found.length === 0) return false
  }

  // 木は根元から丸ごと切り倒す（上のほうの丸太を宙に残さない）
  if (label === 'log') {
    const before = countMatching(bot, LOG_RE)
    const isProtected = (p) => !!bot.__town && insideStructure(bot.__town, p)
    await fellTree(bot, rec, found[0], { stop: () => !!ctx.reflex || !!ctx.stepToken?.cancelled, isProtected })
    const gained = countMatching(bot, LOG_RE) - before
    if (gained > 0) rec.event('mine', { block: label, gained, at: pos(bot.entity.position) })
    return gained > 0
  }

  const targets = found.slice(0, Math.min(want, 4)).map((p) => bot.blockAt(p)).filter(Boolean)
  const before = label === 'log' ? countMatching(bot, LOG_RE) : countItem(bot, 'cobblestone')
  await withTimeout(bot, bot.collectBlock.collect(targets, { ignoreNoPath: true }), COLLECT_TIMEOUT_MS)
  const after = label === 'log' ? countMatching(bot, LOG_RE) : countItem(bot, 'cobblestone')
  if (after > before) rec.event('mine', { block: label, gained: after - before, at: pos(bot.entity.position) })
  return after > before
}

async function explore (bot, rec, looking) {
  const angle = Math.random() * Math.PI * 2
  const p = bot.entity.position
  const target = new Vec3(p.x + Math.cos(angle) * 40, p.y, p.z + Math.sin(angle) * 40)
  rec.event('explore', { looking, to: pos(target) })
  const result = await withTimeout(bot, bot.pathfinder.goto(new goals.GoalNearXZ(target.x, target.z, 4)).catch((err) => err), EXPLORE_TIMEOUT_MS)
  if (result) rec.event('explore_stopped', { reason: result === 'timeout' ? 'timeout' : result.message, at: pos(bot.entity.position) })
}

async function ensureCraftingTable (bot, rec) {
  const tableId = bot.registry.blocksByName.crafting_table.id
  let table = bot.findBlock({ matching: tableId, maxDistance: 32 })
  if (!table) {
    if (countItem(bot, 'crafting_table') === 0 && !(await craft(bot, rec, 'crafting_table', 1))) return null
    // 足元付近の、上が空いている固い地面に置く
    const me = bot.entity.position.floored()
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1]]) {
      const ground = bot.blockAt(me.offset(dx, -1, dz))
      const above = bot.blockAt(me.offset(dx, 0, dz))
      if (ground?.boundingBox === 'block' && above?.name === 'air') {
        await bot.equip(bot.inventory.items().find((i) => i.name === 'crafting_table'), 'hand')
        await bot.placeBlock(ground, new Vec3(0, 1, 0)).catch(() => {})
        break
      }
    }
    table = bot.findBlock({ matching: tableId, maxDistance: 32 })
    if (!table) return null
    rec.event('build', { what: 'crafting_table', at: pos(table.position) })
  }
  await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2))
  return table
}

async function craft (bot, rec, name, count) {
  const item = bot.registry.itemsByName[name]
  let table = null
  let recipe = bot.recipesFor(item.id, null, 1, null)[0]
  if (!recipe) {
    table = await ensureCraftingTable(bot, rec)
    if (!table) return false
    recipe = bot.recipesFor(item.id, null, 1, table)[0]
  }
  if (!recipe) return false

  // 1回分ずつ、自前のクラフト（crafting.js）で作る。bot.craft は 1.21.4 で材料を消したり失敗したりする
  const before = countItem(bot, name)
  const times = Math.ceil(count / recipe.result.count)
  for (let i = 0; i < times; i++) {
    const r = bot.recipesFor(item.id, null, 1, table)[0]
    if (!r) break
    await craftOnce(bot, r, table)
  }
  const made = countItem(bot, name) - before
  if (made > 0) rec.event('craft', { item: name, count: made })
  return made > 0
}

async function craftPlanks (bot, rec, want) {
  const log = bot.inventory.items().find((i) => LOG_RE.test(i.name))
  if (!log) return false
  const planks = log.name.replace(/_(log|stem)$/, '_planks')
  if (!bot.registry.itemsByName[planks]) return false
  return craft(bot, rec, planks, want)
}

// 序盤の決め打ち: 石の道具がそろうまでは、上から順に「まだ満たしていない」ものをやる
function bootstrapSteps (bot, ctx, rec) {
  const logs = () => countMatching(bot, LOG_RE)
  const planks = () => countMatching(bot, PLANKS_RE)
  const has = (name) => countItem(bot, name) > 0
  const stone = () => countItem(bot, 'cobblestone')
  const stoneIds = [bot.registry.blocksByName.stone.id]

  return [
    { name: 'collect_logs', todo: () => logs() + planks() / 4 < 6, run: () => collect(bot, ctx, rec, logBlockIds(bot), 'log', 6) },
    { name: 'craft_planks', todo: () => planks() < 12 && logs() > 0, run: () => craftPlanks(bot, rec, 12) },
    { name: 'craft_sticks', todo: () => countItem(bot, 'stick') < 8 && planks() >= 2, run: () => craft(bot, rec, 'stick', 8) },
    { name: 'wooden_pickaxe', todo: () => !has('wooden_pickaxe') && !has('stone_pickaxe'), run: () => craft(bot, rec, 'wooden_pickaxe', 1) },
    { name: 'collect_stone', todo: () => stone() < 12 && !has('stone_pickaxe'), run: () => collect(bot, ctx, rec, stoneIds, 'stone', 12) },
    { name: 'stone_pickaxe', todo: () => !has('stone_pickaxe') && stone() >= 3, run: () => craft(bot, rec, 'stone_pickaxe', 1) },
    { name: 'stone_sword', todo: () => !has('stone_sword') && stone() >= 2, run: () => craft(bot, rec, 'stone_sword', 1) },
    { name: 'stone_axe', todo: () => !has('stone_axe') && stone() >= 3, run: () => craft(bot, rec, 'stone_axe', 1) }
  ]
}

const BUILD_TIMEOUT_MS = 10 * 60 * 1000
const PAVABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt'])

// 長い作業は、反射が割り込んだときと、時間切れのとき（ctx.stepToken.cancelled）に途中でやめる。続きは次に選ばれたときに
function stopper (ctx) {
  const token = ctx.stepToken
  return () => !!ctx.reflex || !!token?.cancelled
}

async function ensurePlanks (bot, rec, need) {
  while (countMatching(bot, PLANKS_RE) < need && countMatching(bot, LOG_RE) > 0) {
    if (!(await craftPlanks(bot, rec, need - countMatching(bot, PLANKS_RE)))) break
  }
}

// 設計図に要る材料と、足りない分（原木は板材にもできる）
function shortage (bot, need) {
  const stone = materialCount(bot, 'cobblestone')
  const planks = materialCount(bot, 'planks')
  const logs = materialCount(bot, 'log')
  const short = {}
  if ((need.cobblestone ?? 0) > stone) short.cobblestone = need.cobblestone - stone
  if ((need.log ?? 0) > logs) short.log = need.log - logs
  const spareLogs = Math.max(0, logs - (need.log ?? 0))
  if ((need.planks ?? 0) > planks + spareLogs * 4) short.planks = need.planks - planks - spareLogs * 4
  return short
}

const KIND_JA = { cobblestone: '丸石', planks: '板材', log: '原木' }
const describeNeed = (need) => Object.entries(need).map(([k, n]) => `${KIND_JA[k] ?? k} ${n}`).join('・')

// 設計図どおりに建てる（新築・建てかけの続き・修理で共通）
async function buildStructure (bot, ctx, rec, town, structure) {
  const blueprint = blueprintFor(structure)
  const need = materialsNeeded(blueprint)
  await ensurePlanks(bot, rec, need.planks ?? 0)
  const origin = new Vec3(structure.origin.x, structure.origin.y, structure.origin.z)
  const result = await build(bot, rec, origin, blueprint, (kind) => pickMaterial(bot, kind), stopper(ctx))
  if (result.left === 0 && !structure.done) {
    structure.done = true
    structure.doneAt = new Date().toISOString()
    if (structure.plot) town.data.plots[structure.plot] = { state: 'built', building: structure.type }
    // 最初の建物の扉の前を「家」とする
    if (!town.data.home) town.data.home = { x: origin.x + blueprint.door.x, y: origin.y, z: origin.z + blueprint.door.z }
    town.save()
    rec.event('build', { what: structure.type, origin: structure.origin, buildings: town.data.structures.filter((s) => s.done).length })
  } else if (result.missing) {
    rec.event('build_paused', { what: structure.type, missing: result.missing, placed: result.placed, left: result.left })
  }
  return result.placed > 0
}

// 街の中心ができる前の、最初の小さい家（近くの平らな場所を探して建てる）
async function buildSmallHouse (bot, ctx, rec, town) {
  const blueprint = houseBlueprint()
  const h = town.data.home
  const center = h ? new Vec3(h.x, h.y, h.z) : bot.entity.position
  const site = findBuildSite(bot, town, blueprint, center)
  if (!site) {
    rec.event('build_site_not_found', { near: pos(center) })
    await explore(bot, rec, 'build_site')
    return false
  }
  const structure = { type: blueprint.type, spec: SMALL_HOUSE, origin: pos(site.origin), size: blueprint.size, done: false, startedAt: new Date().toISOString() }
  town.data.structures.push(structure)
  town.save()
  rec.event('build_start', { what: structure.type, origin: structure.origin, earthwork: site.cut.length + site.fill.length })
  if (site.cut.length || site.fill.length) {
    const fillItem = () => bot.inventory.items().find((i) => i.name === 'dirt') ?? bot.inventory.items().find((i) => i.name === 'cobblestone')
    if (!(await prepareSite(bot, rec, site, fillItem, stopper(ctx)))) return false
  }
  return buildStructure(bot, ctx, rec, town, structure)
}

// ならした区画に、設計図の建物を建てる（扉は区画の北側の道に向く）
async function buildOnPlot (bot, ctx, rec, town, spec) {
  const plot = readyPlots(town)[0]
  if (!plot) return false
  const bp = specToBlueprint(spec)
  const origin = { x: plot.x0 + Math.floor((PLOT - bp.size.x) / 2), y: plot.level + 1, z: plot.z0 + Math.floor((PLOT - bp.size.z) / 2) }
  const structure = { type: spec.name, spec, origin, size: bp.size, plot: plot.id, done: false, startedAt: new Date().toISOString() }
  town.data.structures.push(structure)
  town.data.plots[plot.id] = { state: 'building', building: spec.name }
  town.save()
  rec.event('build_start', { what: spec.name, origin, plot: plot.id })
  return buildStructure(bot, ctx, rec, town, structure)
}

// 削るものを上から削り、埋める場所を下から埋める
async function doEarthwork (bot, rec, work, stop) {
  const fillItem = () => bot.inventory.items().find((i) => i.name === 'dirt') ?? bot.inventory.items().find((i) => i.name === 'cobblestone')
  const before = work.cut.length + work.fill.length
  await prepareSite(bot, rec, work, fillItem, stop)
  return before
}

async function levelPlot (bot, ctx, rec, town) {
  const plot = nextPlotToLevel(bot, town)
  if (!plot) { town.save(); return false }
  // 進まなかった回数（stuck）は残す
  town.data.plots[plot.id] = { ...(town.data.plots[plot.id] ?? {}), level: plot.level, state: 'leveling' }
  town.save()
  const work = earthwork(bot, town, plot)
  if (!work) {
    town.data.plots[plot.id] = { level: plot.level, state: 'skipped', reason: 'unsuitable' }
    town.save()
    return false
  }
  // 区画の中の木は、先に根元から丸ごと切り倒す（上のほうを残さない）
  const stop = stopper(ctx)
  const bases = new Map()
  for (const p of work.cut) {
    if (!LOG_RE.test(bot.blockAt(p)?.name ?? '')) continue
    let b = p
    while (LOG_RE.test(bot.blockAt(b.offset(0, -1, 0))?.name ?? '')) b = b.offset(0, -1, 0)
    bases.set(b.toString(), b)
  }
  for (const base of bases.values()) {
    if (stop()) return true
    await fellTree(bot, rec, base, { stop, isProtected: (p) => insideStructure(town, p) })
  }
  const work2 = bases.size ? (earthwork(bot, town, plot) ?? work) : work
  if (work2.cut.length || work2.fill.length) await doEarthwork(bot, rec, work2, stop)
  const left = earthwork(bot, town, plot)
  const before = work.cut.length + work.fill.length
  const remaining = left ? left.cut.length + left.fill.length : null
  const sample = left ? [...left.cut.slice(0, 3).map((p) => `削る ${bot.blockAt(p)?.name}@${p}`), ...left.fill.slice(0, 3).map((p) => `埋める @${p}`)] : []
  rec.event('level', { plot: plot.id, before, remaining, sample })
  if (remaining === 0) {
    town.data.plots[plot.id] = { level: plot.level, state: 'leveled' }
    rec.event('plot_leveled', { plot: plot.id })
    town.save()
    return true
  }
  // 進まなかった（届かない・置けない作業が残っている）。3回続いたら、残りが少なければ良しとし、多ければ飛ばす
  if (remaining === null || remaining >= before) {
    const stuck = (town.data.plots[plot.id]?.stuck ?? 0) + 1
    if (stuck >= 3) {
      const good = remaining !== null && remaining <= 20
      town.data.plots[plot.id] = good ? { level: plot.level, state: 'leveled', leftover: remaining } : { state: 'skipped', reason: 'stuck' }
      rec.event(good ? 'plot_leveled' : 'plot_skipped', { plot: plot.id, leftover: remaining })
    } else {
      town.data.plots[plot.id] = { level: plot.level, state: 'leveling', stuck }
    }
    town.save()
    return false
  }
  town.data.plots[plot.id] = { level: plot.level, state: 'leveling' }
  town.save()
  return true
}

async function ensureShovel (bot, rec) {
  if (bot.inventory.items().some((i) => i.name.endsWith('_shovel'))) return true
  return craft(bot, rec, materialCount(bot, 'cobblestone') >= 1 ? 'stone_shovel' : 'wooden_shovel', 1)
}

async function buildRoad (bot, ctx, rec, town) {
  const key = nextRoad(town)
  if (!key) return false
  const b = roadBounds(town, key)
  let work = roadwork(bot, town, b)
  if (work?.unseen) {
    // 遠くて地形が見えていないので、まず近くまで行く
    await bot.pathfinder.goto(new goals.GoalNearXZ((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, 4)).catch(() => {})
    work = roadwork(bot, town, b)
    if (!work || work.unseen) {
      if (!work) { town.data.roads[key] = { state: 'skipped' }; town.save() }
      return false
    }
  }
  if (!work) {
    town.data.roads[key] = { state: 'skipped' }
    town.save()
    return false
  }
  const stop = stopper(ctx)
  // 道の上の木は根元から丸ごと切る
  for (const p of work.cut) {
    if (stop()) return true
    if (!LOG_RE.test(bot.blockAt(p)?.name ?? '')) continue
    let base = p
    while (LOG_RE.test(bot.blockAt(base.offset(0, -1, 0))?.name ?? '')) base = base.offset(0, -1, 0)
    await fellTree(bot, rec, base, { stop, isProtected: (q) => insideStructure(town, q) })
  }
  work = roadwork(bot, town, b)
  if (!work || work.unseen) return false
  if (work.cut.length) await doEarthwork(bot, rec, work, stop)
  if (stop()) return true
  if (!(await ensureShovel(bot, rec))) return false

  // 草や土をシャベルで「土の道」にする
  let paved = 0
  for (const p of work.surface) {
    if (stop()) return paved > 0
    const top = bot.blockAt(p)
    const above = bot.blockAt(p.offset(0, 1, 0))
    if (!top || !PAVABLE.has(top.name) || above?.name !== 'air') continue
    try {
      await bot.pathfinder.goto(new goals.GoalLookAtBlock(top.position, bot.world, { reach: 4 }))
      await bot.equip(bot.inventory.items().find((i) => i.name.endsWith('_shovel')), 'hand')
      await bot.activateBlock(top)
      paved++
    } catch {}
  }
  const left = roadwork(bot, town, b)
  if (left && !left.unseen && left.cut.length === 0) {
    town.data.roads[key] = { state: 'done' }
    rec.event('road', { key, paved })
  }
  town.save()
  return paved > 0
}

// 完成した建物のうち、設計図と比べてブロックが欠けているもの（壁を壊された、など）
function damagedBuildings (bot, town) {
  return town.data.structures.filter((s) => s.done).map((s) => {
    const missing = blueprintFor(s).blocks.filter((b) => {
      const block = bot.blockAt(new Vec3(s.origin.x + b.x, s.origin.y + b.y, s.origin.z + b.z))
      return block && block.boundingBox !== 'block'
    }).length
    return { structure: s, missing }
  }).filter((d) => d.missing > 0)
}

// 建てられる設計図: 最初から入っているもの + 考える係が設計したもの
export function designLibrary (ctx) {
  const own = (ctx.memory?.designs ?? []).map(normalizeSpec)
  return [...BUILTIN_SPECS.filter((s) => s !== SMALL_HOUSE), ...own]
}

// ベッドは同じ色の羊毛3つで作る。色ごとに数えて一番多い色の数
function sameColorWool (bot) {
  const byColor = {}
  for (const i of bot.inventory.items()) if (i.name.endsWith('_wool')) byColor[i.name] = (byColor[i.name] ?? 0) + i.count
  return Math.max(0, ...Object.values(byColor))
}

// 今選べる行動。label は判断係に見せる説明
function skillOptions (bot, ctx, rec, town, craftFn) {
  const logs = countMatching(bot, LOG_RE)
  const planks = countMatching(bot, PLANKS_RE)
  const stone = countItem(bot, 'cobblestone')
  const saplings = countMatching(bot, /_sapling$/)
  const food = foodCount(bot)
  const stoneIds = [bot.registry.blocksByName.stone.id]
  const unfinished = town.data.structures.find((s) => !s.done)
  const home = town.data.home
  const homeDist = home ? Math.round(bot.entity.position.distanceTo(new Vec3(home.x, home.y, home.z))) : null
  const slotsUsed = bot.inventory.items().length
  const center = ensureCenter(town)

  const options = [
    { key: 'collect_logs', label: `木を切る（今: 原木 ${logs}本、板材 ${planks}枚）`, run: () => collect(bot, ctx, rec, logBlockIds(bot), 'log', 8) },
    { key: 'mine_stone', label: `石を掘る（今: 丸石 ${stone}個）`, run: () => collect(bot, ctx, rec, stoneIds, 'stone', 8) },
    { key: 'hunt', label: `動物を狩って食べ物を集める（今: 食べ物 ${food}個）`, run: async () => (await hunt(bot, rec)) ?? explore(bot, rec, 'animals') }
  ]

  if (unfinished) {
    options.push({ key: 'finish_building', label: `建てかけの「${unfinished.type}」を仕上げる`, run: () => buildStructure(bot, ctx, rec, town, unfinished), timeout: BUILD_TIMEOUT_MS })
  } else if (!center) {
    const need = materialsNeeded(houseBlueprint())
    if (Object.keys(shortage(bot, need)).length === 0) {
      options.push({ key: 'build_house', label: `最初の家を建てる（${describeNeed(need)} を使う）`, run: () => buildSmallHouse(bot, ctx, rec, town), timeout: BUILD_TIMEOUT_MS })
    }
  }

  if (center) {
    const plot = nextPlotToLevel(bot, town)
    if (plot) options.push({ key: 'level_plot', label: `街の区画 ${plot.id} の地面をならす（建物を建てる準備。削った土は埋めるのに使う）`, run: () => levelPlot(bot, ctx, rec, town), timeout: BUILD_TIMEOUT_MS })
    const road = nextRoad(town)
    if (road) options.push({ key: 'build_road', label: '街の道を1区間のばす（長さ17・幅3。地面をならしてシャベルで土の道にする）', run: () => buildRoad(bot, ctx, rec, town), timeout: BUILD_TIMEOUT_MS })
    if (!unfinished && readyPlots(town).length) {
      for (const spec of designLibrary(ctx)) {
        const need = materialsNeeded(specToBlueprint(spec))
        if (Object.keys(shortage(bot, need)).length) continue
        options.push({
          key: `build:${spec.name}`,
          label: `ならした区画に「${spec.name}」を建てる（${spec.width}×${spec.depth}、高さ${spec.height}。${describeNeed(need)} を使う）`,
          run: () => buildOnPlot(bot, ctx, rec, town, spec),
          timeout: BUILD_TIMEOUT_MS
        })
      }
    }
  }

  if (saplings > 0) options.push({ key: 'plant_saplings', label: `苗木を植えて木を増やす（苗木 ${saplings}本）`, run: () => plantSaplings(bot, rec, town) })
  if (home && slotsUsed >= 24) options.push({ key: 'store_items', label: `家のチェストに荷物をしまう（持ち物 ${slotsUsed}/36 枠）`, run: () => storeItems(bot, rec, town, craftFn) })
  if (home && homeDist > 32) options.push({ key: 'go_home', label: `家に戻る（${homeDist}ブロック先）`, run: () => goHome(bot, town) })
  const t = bot.time.timeOfDay
  const nightNear = t >= 11500 && t < 23500
  const doneHouses = finishedHouses(town)
  const wool = sameColorWool(bot)
  if (nightNear) {
    options.push({ key: 'dig_in', label: 'その場で穴を掘ってこもり、朝まで待つ', run: () => ctx.digIn() })
    if (doneHouses.length) {
      const doors = doneHouses.some((h) => h.door)
      options.push({ key: 'stay_home', label: `家に帰って中で朝まで過ごす（家まで ${homeDist ?? '?'}ブロック、扉${doors ? 'あり' : 'なし'}）`, run: () => stayHome(bot, rec, town), timeout: BUILD_TIMEOUT_MS })
    }
    // ベッドで寝られるのは夜（12542 以降）か雷雨のときだけ
    const canSleep = (t >= 12542 && t < 23460) || bot.thunderState > 0
    if (town.data.bed && canSleep) options.push({ key: 'sleep', label: '家のベッドで寝て朝にする（復活地点も家になる）', run: () => sleepInBed(bot, rec, town), timeout: BUILD_TIMEOUT_MS })
  }
  const damaged = damagedBuildings(bot, town)
  if (damaged.length && stone + planks > 0) {
    const d = damaged[0]
    options.push({ key: 'repair', label: `「${d.structure.type}」の壊れたところを直す（${d.missing}ブロック欠けている）`, run: () => buildStructure(bot, ctx, rec, town, d.structure), timeout: BUILD_TIMEOUT_MS })
  }
  if (doneHouses.some((h) => !h.door) && (planks >= 6 || logs >= 2)) {
    options.push({ key: 'make_door', label: '扉を作って建物の入口につける（夜に敵が入ってこなくなる）', run: () => makeDoor(bot, rec, town, craftFn) })
  }
  if (doneHouses.length && !town.data.bed && wool >= 3) {
    options.push({ key: 'make_bed', label: 'ベッドを作って家に置く（寝れば夜を飛ばせて、死んでも家で復活できる）', run: () => makeBed(bot, rec, town, craftFn) })
  }
  options.push({ key: 'explore', label: '周りを探検する（近くに木・石・動物・建てる場所が見つからないときだけ）', run: () => explore(bot, rec, 'curious') })

  // 2回続けて失敗した行動は、今回は出さない
  const last2 = ctx.history.slice(-2)
  return options.filter((o) => !(last2.length === 2 && last2.every((h) => h.key === o.key && !h.ok)))
}

// 大きな街に近づくために、今いちばん効く一歩
function nextTownStep (town, unfinished) {
  if (unfinished) return `建てかけの「${unfinished.type}」を仕上げる`
  if (!town.data.center) return 'まず最初の家を建てる（家の前が街の中心になる）'
  const plots = Object.entries(town.data.plots ?? {})
  const leveling = plots.find(([, p]) => p.state === 'leveling')
  if (plots.some(([, p]) => p.state === 'leveled')) return 'ならした区画が空いているので、材料を集めて大きな建物を建てる'
  if (leveling) return `区画 ${leveling[0]} のならしを終わらせる（終われば大きな建物を建てられる）`
  return '空いている区画をならして、建物を建てる場所を作る'
}

export function describeSituation (bot, ctx, town) {
  const t = bot.time.timeOfDay
  const night = t >= 12500 && t < 23500
  const minutesToNight = Math.max(0, Math.round((12500 - t) / 20 / 60))
  const lines = []
  lines.push(night ? '時刻: 夜（敵が多い）' : `時刻: 昼（あと約${minutesToNight}分で夜）`)
  lines.push(`HP ${Math.round(bot.health)}/20、満腹度 ${bot.food}/20、食べ物 ${foodCount(bot)}個`)

  const inv = {}
  for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] ?? 0) + i.count
  const tools = Object.keys(inv).filter((n) => /_sword$|_pickaxe$|_axe$|_shovel$/.test(n))
  lines.push(`持ち物: 原木 ${countMatching(bot, LOG_RE)}、板材 ${countMatching(bot, PLANKS_RE)}、丸石 ${inv.cobblestone ?? 0}、` +
    `土 ${inv.dirt ?? 0}、苗木 ${countMatching(bot, /_sapling$/)}、道具: ${tools.join('・') || 'なし'}（${bot.inventory.items().length}/36 枠）`)

  const done = town.data.structures.filter((s) => s.done)
  const unfinished = town.data.structures.find((s) => !s.done)
  const kinds = {}
  for (const s of done) kinds[s.type] = (kinds[s.type] ?? 0) + 1
  lines.push(`街の建物: ${Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join('、') || 'なし'}${unfinished ? `（建てかけ: ${unfinished.type}）` : ''}、植えた苗木 ${town.data.saplingsPlanted}本`)
  const summary = townSummary(town)
  if (summary) lines.push(summary)
  lines.push(`街づくりの次の一歩: ${nextTownStep(town, unfinished)}`)
  // 次に建てたい建物の材料（足りない分）
  if (town.data.center && !unfinished) {
    const wants = designLibrary(ctx).map((spec) => ({ spec, short: shortage(bot, materialsNeeded(specToBlueprint(spec))) }))
      .filter((w) => Object.keys(w.short).length).slice(0, 2)
    for (const w of wants) lines.push(`「${w.spec.name}」を建てるには、あと ${describeNeed(w.short)} が要る`)
  }
  const doors = done.filter((st) => st.door).length
  const wool = sameColorWool(bot)
  lines.push(`夜の備え: 扉のある建物 ${doors}/${done.length}、ベッド ${town.data.bed ? 'あり' : `なし（同じ色の羊毛 ${wool}/3 で作れる。羊を狩ると手に入る）`}`)
  // 考える係が決めた方針と、学んだ教訓
  if (ctx.memory?.focus) lines.push(`今の方針: ${ctx.memory.focus}`)
  if (ctx.memory?.lessons?.length) lines.push(`教訓: ${ctx.memory.lessons.slice(-5).join(' / ')}`)
  if (ctx.lastDeath) {
    const ago = Math.round((Date.now() - ctx.lastDeath.at) / 60000)
    lines.push(`最近の死亡: ${ctx.lastDeath.cause ?? '不明'}（${ago}分前）`)
  }
  if (ctx.history.length) {
    lines.push('直前にやったこと: ' + ctx.history.slice(-3).map((h) => `${h.key}（${h.ok ? '成功' : '失敗'}）`).join(' → '))
  }
  return lines.join('\n')
}

// 考える係に見せる「体が今できること」
export function listAbilities (bot, ctx, rec, town) {
  return skillOptions(bot, ctx, rec, town, (name, count) => craft(bot, rec, name, count)).map((o) => o.label)
}

// LLM を使わないとき（または応答がないとき）の判断。優先順位で選ぶ。
// 最近その行動を2回やって2回とも失敗していたら、一度飛ばす。
function ruleChoice (options, bot, ctx, town) {
  const keys = options.map((o) => o.key)
  const failing = (k) => {
    const tries = ctx.history.slice(-8).filter((h) => h.key === k).slice(-2)
    return tries.length === 2 && tries.every((h) => !h.ok)
  }
  const has = (k) => keys.includes(k) && !failing(k)
  const pick = (...ks) => ks.find(has)

  // 夜: 寝る > 家にこもる > 穴にこもる
  const night = pick('sleep', 'stay_home', 'dig_in')
  if (night) return night
  // 狩りは、お腹が減ってきて手持ちの食べ物も少ないときだけ（生肉はすぐ食べてしまうので、手持ちの数だけで決めない）
  if (bot.food < 14 && foodCount(bot) < 3 && has('hunt')) return 'hunt'
  const care = pick('repair', 'finish_building', 'build_house', 'make_door', 'make_bed', 'store_items')
  if (care) return care
  // 建てられる建物があれば建てる（同じものばかりにならないよう、ランダム）
  const builds = keys.filter((k) => k.startsWith('build:') && !failing(k))
  if (builds.length) return builds[Math.floor(Math.random() * builds.length)]

  // 街づくり: ならした区画がなければならす。道はときどき
  const hasReady = readyPlots(town).length > 0
  const lastTown = ctx.history.slice(-6).filter((h) => h.key === 'level_plot' || h.key === 'build_road').length
  if (!hasReady && has('level_plot') && lastTown < 3) return 'level_plot'
  if (has('build_road') && lastTown === 0 && Math.random() < 0.5) return 'build_road'

  // 材料集め: 建てかけの建物、なければ次に建てたい建物に足りない方を集める
  if (has('plant_saplings') && Math.random() < 0.1) return 'plant_saplings'
  const unfinished = town.data.structures.find((s) => !s.done)
  const want = unfinished
    ? shortage(bot, materialsNeeded(blueprintFor(unfinished)))
    : designLibrary(ctx).map((spec) => shortage(bot, materialsNeeded(specToBlueprint(spec)))).find((s) => Object.keys(s).length)
  if (want?.cobblestone && has('mine_stone')) return 'mine_stone'
  if ((want?.log || want?.planks) && has('collect_logs')) return 'collect_logs'
  const gather = pick(Math.random() < 0.5 ? 'mine_stone' : 'collect_logs', 'mine_stone', 'collect_logs', 'hunt', 'explore')
  return gather ?? keys[0]
}

export async function runActivity (bot, ctx, rec, { decider, town, goal }) {
  const bootstrap = bootstrapSteps(bot, ctx, rec)
  const craftFn = (name, count) => craft(bot, rec, name, count)
  ctx.history = ctx.history ?? []
  bot.__town = town
  let failures = 0
  // 区画を街全体の高さでならしていたころに「飛ばした」区画と道を、もう一度候補に戻す
  if (town.data.center && town.data.planVersion !== 2) {
    for (const [id, p] of Object.entries(town.data.plots)) if (p.state === 'skipped' || p.state === 'leveling') delete town.data.plots[id]
    for (const [k, r] of Object.entries(town.data.roads)) if (r.state === 'skipped') delete town.data.roads[k]
    town.data.planVersion = 2
    town.save()
  }

  while (bot.entity) {
    if (ctx.reflex || ctx.paused) {
      ctx.task = ctx.paused ? 'paused' : null
      await sleep(1000)
      continue
    }
    updateMovements(bot, town)

    // 最初の道具づくりは、2回続けて失敗した手順をいったん飛ばして、ほかの行動（材料集めなど）に回す
    const recent = ctx.history.slice(-2)
    const blocked = (name) => recent.length === 2 && recent.every((h) => h.key === name && !h.ok)
    let step = bootstrap.find((s) => s.todo() && !blocked(s.name))
    let timeout = STEP_TIMEOUT_MS
    if (!step) {
      // 石の道具がそろったら、判断係に次の行動を選ばせる
      const options = skillOptions(bot, ctx, rec, town, craftFn)
      const situation = describeSituation(bot, ctx, town)
      let choice
      if (!decider) {
        choice = ruleChoice(options, bot, ctx, town)
        rec.event('decision', { choice, by: 'rules' })
      } else try {
        const result = await decider.choose({ goal: goal(), situation, question: '次に何をする？', options })
        choice = result.choice
        rec.event('decision', { choice, probs: result.probs, ms: result.ms, promptTokens: result.promptTokens, situation, options: options.map((o) => o.label) })
      } catch (err) {
        choice = ruleChoice(options, bot, ctx, town)
        rec.event('decision', { choice, fallback: true, error: err.message })
      }
      const option = options.find((o) => o.key === choice)
      step = { name: option.key, run: option.run }
      timeout = option.timeout ?? STEP_TIMEOUT_MS
    }

    ctx.task = step.name
    // 時間切れになったら token.cancelled を立てて、長い作業（ならし・建築・道）に途中でやめさせる
    const token = { cancelled: false }
    ctx.stepToken = token
    let ok = false
    try {
      const result = await withTimeout(bot, step.run(), timeout)
      if (result === 'timeout') token.cancelled = true
      if (result === 'timeout') rec.event('task_timeout', { task: step.name, at: pos(bot.entity.position) })
      ok = result !== false && result !== 'timeout'
    } catch (err) {
      if (!ctx.reflex) rec.event('task_error', { task: step.name, error: err.message })
    }
    rec.event('step', { key: step.name, ok })
    ctx.lastStepAt = Date.now()
    ctx.history.push({ key: step.name, ok })
    if (ctx.history.length > 20) ctx.history.shift()
    failures = ok ? 0 : failures + 1

    // 同じところで失敗し続けたら、少し移動して気分を変える
    if (failures >= 3 && !ctx.reflex) {
      failures = 0
      await explore(bot, rec, step.name)
    }
    await sleep(300)
  }
}
