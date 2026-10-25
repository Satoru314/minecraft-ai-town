// 行動: 判断モデルをつなぐまでの、決め打ちの手順。
// 木 → 作業台 → 木のツルハシ → 石 → 石の道具 → あとは木と石を貯め続ける。
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { countItem, countMatching, pos, sleep } from './util.js'
import { updateMovements } from './movement.js'

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
    timer = setTimeout(async () => {
      if (bot.collectBlock) await bot.collectBlock.cancelTask().catch(() => {})
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

// 丸太が地面から何ブロック上にあるか（下に続く丸太をたどって数える）
function heightAboveGround (bot, p) {
  let h = 0
  let below = bot.blockAt(p.offset(0, -1, 0))
  while (below && LOG_RE.test(below.name) && h < 30) {
    h++
    below = bot.blockAt(p.offset(0, -1 - h, 0))
  }
  return below?.boundingBox === 'block' ? h : Infinity
}

// 足場なしで手が届くものだけ狙う（木の上のほうの丸太、深すぎる石は無視）
function reachableFilter (bot, label) {
  const y = bot.entity.position.y
  if (label === 'log') return (p) => heightAboveGround(bot, p) <= 3
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
  // 材料が足りなければ回数を減らして作る
  for (let times = Math.ceil(count / recipe.result.count); times >= 1; times--) {
    try {
      await bot.craft(recipe, times, table)
      rec.event('craft', { item: name, count: times * recipe.result.count })
      return true
    } catch (err) {
      if (!/missing ingredient/i.test(err.message) || times === 1) throw err
    }
  }
  return false
}

async function craftPlanks (bot, rec, want) {
  const log = bot.inventory.items().find((i) => LOG_RE.test(i.name))
  if (!log) return false
  const planks = log.name.replace(/_(log|stem)$/, '_planks')
  if (!bot.registry.itemsByName[planks]) return false
  return craft(bot, rec, planks, want)
}

// 上から順に見て、最初に「まだ満たしていない」ものをやる
function steps (bot, ctx, rec) {
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
    { name: 'stone_axe', todo: () => !has('stone_axe') && stone() >= 3, run: () => craft(bot, rec, 'stone_axe', 1) },
    // ここから先は判断モデルが入るまでの「貯める」だけ
    { name: 'stockpile_logs', todo: () => logs() < 64, run: () => collect(bot, ctx, rec, logBlockIds(bot), 'log', 8) },
    { name: 'stockpile_stone', todo: () => stone() < 64, run: () => collect(bot, ctx, rec, stoneIds, 'stone', 8) }
  ]
}

export async function runActivity (bot, ctx, rec) {
  const list = steps(bot, ctx, rec)
  let failures = 0
  while (bot.entity) {
    // 夜に避難できなかったときは、戦闘の反射を生かしたまま作業を続ける
    if ((ctx.reflex && ctx.reflex !== 'night_no_shelter') || ctx.paused) {
      ctx.task = ctx.paused ? 'paused' : null
      await sleep(1000)
      continue
    }
    updateMovements(bot)
    const step = list.find((s) => s.todo())
    if (!step) {
      ctx.task = 'idle'
      await sleep(5000)
      continue
    }
    ctx.task = step.name
    try {
      const ok = await withTimeout(bot, step.run(), STEP_TIMEOUT_MS)
      if (ok === 'timeout') rec.event('task_timeout', { task: step.name, at: pos(bot.entity.position) })
      failures = ok === false || ok === 'timeout' ? failures + 1 : 0
    } catch (err) {
      failures++
      if (!ctx.reflex) rec.event('task_error', { task: step.name, error: err.message })
    }
    // 同じところで失敗し続けたら、少し移動して気分を変える
    if (failures >= 3 && !ctx.reflex) {
      failures = 0
      await explore(bot, rec, step.name)
    }
    await sleep(300)
  }
}
