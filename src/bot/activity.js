// 行動: 判断モデルをつなぐまでの、決め打ちの手順。
// 木 → 作業台 → 木のツルハシ → 石 → 石の道具 → あとは木と石を貯め続ける。
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { countItem, countMatching, pos, sleep } from './util.js'
import { updateMovements } from './movement.js'
import { build, findBuildSite, houseBlueprint, materialsNeeded, prepareSite } from './build.js'
import { foodCount, goHome, hunt, plantSaplings, storeItems } from './skills.js'

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

  // 1.21.4 では複数回分をまとめて作ると、余った材料がクラフト欄に置き去りになって消える。
  // 1回分ずつ作り、持ち物のクラフト欄（2x2）を使ったときは毎回「画面を閉じる」を送って材料を持ち物に戻させる。
  const before = countItem(bot, name)
  const times = Math.ceil(count / recipe.result.count)
  for (let i = 0; i < times; i++) {
    const r = bot.recipesFor(item.id, null, 1, table)[0]
    if (!r) break
    await bot.craft(r, 1, table)
    if (!table) bot._client.write('close_window', { windowId: 0 })
    await bot.waitForTicks(4)
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

async function buildHouse (bot, ctx, rec, town) {
  const blueprint = houseBlueprint()
  const need = materialsNeeded(blueprint)
  // 屋根の板材が足りなければ原木から作る
  while (countMatching(bot, PLANKS_RE) < need.roof && countMatching(bot, LOG_RE) > 0) {
    if (!(await craftPlanks(bot, rec, need.roof - countMatching(bot, PLANKS_RE)))) break
  }

  const stop = () => !!ctx.reflex && ctx.reflex !== 'night_no_shelter'
  let structure = town.data.structures.find((s) => !s.done)
  let site
  if (!structure) {
    const h = town.data.home
    const center = h ? new Vec3(h.x, h.y, h.z) : bot.entity.position
    site = findBuildSite(bot, town, blueprint, center)
    if (!site) {
      rec.event('build_site_not_found', { near: pos(center) })
      await explore(bot, rec, 'build_site')
      return false
    }
    structure = { type: blueprint.type, origin: pos(site.origin), size: blueprint.size, done: false, startedAt: new Date().toISOString() }
    town.data.structures.push(structure)
    town.save()
    rec.event('build_start', { what: structure.type, origin: structure.origin, earthwork: site.cut.length + site.fill.length })
  }

  const origin = new Vec3(structure.origin.x, structure.origin.y, structure.origin.z)
  // 地面をならすのは、新しい場所を見つけた直後の1回だけ（建てかけを再開するときに、自分の壁を削らないように）
  if (site && (site.cut.length || site.fill.length)) {
    const fillItem = () => bot.inventory.items().find((i) => i.name === 'dirt') ?? bot.inventory.items().find((i) => i.name === 'cobblestone')
    if (!(await prepareSite(bot, rec, site, fillItem, stop))) return false
  }
  const pick = (kind) => {
    const items = bot.inventory.items()
    if (kind === 'roof') return items.find((i) => PLANKS_RE.test(i.name)) ?? items.find((i) => i.name === 'cobblestone')
    return items.find((i) => i.name === 'cobblestone') ?? items.find((i) => i.name === 'cobbled_deepslate')
  }
  const result = await build(bot, rec, origin, blueprint, pick, stop)
  if (result.left === 0) {
    structure.done = true
    structure.doneAt = new Date().toISOString()
    // 最初の家の扉の前を「家」とする
    if (!town.data.home) town.data.home = { x: origin.x + blueprint.door.x, y: origin.y, z: origin.z + blueprint.door.z }
    town.save()
    rec.event('build', { what: structure.type, origin: structure.origin, houses: town.data.structures.filter((s) => s.done).length })
  } else if (result.missing) {
    rec.event('build_paused', { missing: result.missing, placed: result.placed, left: result.left })
  }
  return result.placed > 0
}

// 今選べる行動。label は判断係に見せる説明
function skillOptions (bot, ctx, rec, town, craftFn) {
  const logs = countMatching(bot, LOG_RE)
  const planks = countMatching(bot, PLANKS_RE)
  const stone = countItem(bot, 'cobblestone')
  const saplings = countMatching(bot, /_sapling$/)
  const food = foodCount(bot)
  const stoneIds = [bot.registry.blocksByName.stone.id]
  const need = materialsNeeded(houseBlueprint())
  const unfinished = town.data.structures.find((s) => !s.done)
  const houses = town.data.structures.filter((s) => s.done).length
  const canBuild = unfinished || (stone >= need.wall && planks + logs * 4 >= need.roof)
  const home = town.data.home
  const homeDist = home ? Math.round(bot.entity.position.distanceTo(new Vec3(home.x, home.y, home.z))) : null
  const slotsUsed = bot.inventory.items().length

  const options = [
    { key: 'collect_logs', label: `木を切る（今: 原木 ${logs}本、板材 ${planks}枚）`, run: () => collect(bot, ctx, rec, logBlockIds(bot), 'log', 8) },
    { key: 'mine_stone', label: `石を掘る（今: 丸石 ${stone}個）`, run: () => collect(bot, ctx, rec, stoneIds, 'stone', 8) },
    { key: 'hunt', label: `動物を狩って食べ物を集める（今: 食べ物 ${food}個）`, run: async () => (await hunt(bot, rec)) ?? explore(bot, rec, 'animals') }
  ]
  if (canBuild) {
    options.push({
      key: 'build_house',
      label: unfinished ? '建てかけの家を仕上げる' : `家を建てる（${houses + 1}軒目。丸石 ${need.wall}個と板材 ${need.roof}枚を使う）`,
      run: () => buildHouse(bot, ctx, rec, town),
      timeout: BUILD_TIMEOUT_MS
    })
  }
  if (saplings > 0) options.push({ key: 'plant_saplings', label: `苗木を植えて木を増やす（苗木 ${saplings}本）`, run: () => plantSaplings(bot, rec, town) })
  if (home && slotsUsed >= 24) options.push({ key: 'store_items', label: `家のチェストに荷物をしまう（持ち物 ${slotsUsed}/36 枠）`, run: () => storeItems(bot, rec, town, craftFn) })
  if (home && homeDist > 32) options.push({ key: 'go_home', label: `家に戻る（${homeDist}ブロック先）`, run: () => goHome(bot, town) })
  options.push({ key: 'explore', label: '周りを探検して新しい場所を見つける', run: () => explore(bot, rec, 'curious') })

  // 2回続けて失敗した行動は、今回は出さない
  const last2 = ctx.history.slice(-2)
  return options.filter((o) => !(last2.length === 2 && last2.every((h) => h.key === o.key && !h.ok)))
}

function describeSituation (bot, ctx, town) {
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

  const houses = town.data.structures.filter((s) => s.done).length
  const unfinished = town.data.structures.some((s) => !s.done)
  lines.push(`街: 家 ${houses}軒${unfinished ? '（建てかけ1軒あり）' : ''}、植えた苗木 ${town.data.saplingsPlanted}本、チェスト ${town.data.chest ? 'あり' : 'なし'}`)
  if (houses === 0 && !unfinished) {
    const need = materialsNeeded(houseBlueprint())
    lines.push(`家を建てるには 丸石 ${need.wall}個・板材 ${need.roof}枚 が要る（原木1本 = 板材4枚）`)
  }
  if (ctx.lastDeath) {
    const ago = Math.round((Date.now() - ctx.lastDeath.at) / 60000)
    lines.push(`最近の死亡: ${ctx.lastDeath.cause ?? '不明'}（${ago}分前）`)
  }
  if (ctx.history.length) {
    lines.push('直前にやったこと: ' + ctx.history.slice(-3).map((h) => `${h.key}（${h.ok ? '成功' : '失敗'}）`).join(' → '))
  }
  return lines.join('\n')
}

function fallbackChoice (options, bot) {
  const keys = options.map((o) => o.key)
  if (foodCount(bot) < 3 && keys.includes('hunt')) return 'hunt'
  if (keys.includes('build_house')) return 'build_house'
  return keys[0]
}

export async function runActivity (bot, ctx, rec, { decider, town, goal }) {
  const bootstrap = bootstrapSteps(bot, ctx, rec)
  const craftFn = (name, count) => craft(bot, rec, name, count)
  ctx.history = ctx.history ?? []
  let failures = 0

  while (bot.entity) {
    // 夜に避難できなかったときは、戦闘の反射を生かしたまま作業を続ける
    if ((ctx.reflex && ctx.reflex !== 'night_no_shelter') || ctx.paused) {
      ctx.task = ctx.paused ? 'paused' : null
      await sleep(1000)
      continue
    }
    updateMovements(bot)

    let step = bootstrap.find((s) => s.todo())
    let timeout = STEP_TIMEOUT_MS
    if (!step) {
      // 石の道具がそろったら、判断係に次の行動を選ばせる
      const options = skillOptions(bot, ctx, rec, town, craftFn)
      const situation = describeSituation(bot, ctx, town)
      let choice
      try {
        const result = await decider.choose({ goal: goal(), situation, question: '次に何をする？', options })
        choice = result.choice
        rec.event('decision', { choice, probs: result.probs, ms: result.ms, promptTokens: result.promptTokens })
      } catch (err) {
        choice = fallbackChoice(options, bot)
        rec.event('decision', { choice, fallback: true, error: err.message })
      }
      const option = options.find((o) => o.key === choice)
      step = { name: option.key, run: option.run }
      timeout = option.timeout ?? STEP_TIMEOUT_MS
    }

    ctx.task = step.name
    let ok = false
    try {
      const result = await withTimeout(bot, step.run(), timeout)
      if (result === 'timeout') rec.event('task_timeout', { task: step.name, at: pos(bot.entity.position) })
      ok = result !== false && result !== 'timeout'
    } catch (err) {
      if (!ctx.reflex) rec.event('task_error', { task: step.name, error: err.message })
    }
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
