// 石の道具がそろったあとに、判断係が選ぶスキル（狩り・苗木・チェスト・帰宅）。
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { countItem, pos, sleep } from './util.js'

const { goals } = pathfinderPkg

export const FOOD_MOBS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'])
const WEAPONS = ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe']
const KEEP = /_sword$|_pickaxe$|_axe$|_shovel$|_hoe$|_helmet$|_chestplate$|_leggings$|_boots$|^shield$|_sapling$/

export function foodCount (bot) {
  return bot.inventory.items().filter((i) => bot.registry.foodsByName[i.name] &&
    !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'].includes(i.name)).reduce((n, i) => n + i.count, 0)
}

export async function hunt (bot, rec) {
  const me = bot.entity.position
  const target = bot.nearestEntity((e) => FOOD_MOBS.has(e.name) && e.position.distanceTo(me) < 48)
  if (!target) return null // 呼び出し側で探索する
  const weapon = WEAPONS.map((n) => bot.inventory.items().find((i) => i.name === n)).find(Boolean)
  if (weapon) await bot.equip(weapon, 'hand')

  const before = foodCount(bot)
  const lastSeen = target.position.clone()
  bot.pvp.attack(target)
  const started = Date.now()
  while (bot.entities[target.id] && target.isValid !== false && Date.now() - started < 30000) {
    lastSeen.update(target.position)
    await sleep(300)
  }
  bot.pvp.stop()

  // 落としたものを拾う
  for (const item of Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(lastSeen) < 6)) {
    await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5)).catch(() => {})
  }
  await sleep(500)
  const gained = foodCount(bot) - before
  rec.event('hunt', { target: target.name, gained, at: pos(lastSeen) })
  return gained > 0
}

// 家の周り（なければ今いる場所の周り）の、草か土の上に苗木を植える。木同士は3マス空ける
export async function plantSaplings (bot, rec, town, max = 4) {
  const center = town.data.home ? new Vec3(town.data.home.x, town.data.home.y, town.data.home.z) : bot.entity.position
  const groundIds = ['grass_block', 'dirt', 'podzol', 'coarse_dirt'].map((n) => bot.registry.blocksByName[n]?.id).filter(Boolean)
  const spots = bot.findBlocks({ matching: groundIds, point: center, maxDistance: 14, count: 200 }).filter((p) => {
    if (town.occupied(p.x, p.z)) return false
    const above = bot.blockAt(p.offset(0, 1, 0))
    const above2 = bot.blockAt(p.offset(0, 2, 0))
    if (above?.name !== 'air' || above2?.name !== 'air') return false
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const n = bot.blockAt(p.offset(dx, 1, dz))?.name ?? ''
        if (n.endsWith('_sapling') || n.endsWith('_log')) return false
      }
    }
    return true
  })

  let planted = 0
  const used = []
  for (const p of spots) {
    if (planted >= max) break
    if (used.some((u) => Math.abs(u.x - p.x) <= 3 && Math.abs(u.z - p.z) <= 3)) continue
    const sapling = bot.inventory.items().find((i) => i.name.endsWith('_sapling'))
    if (!sapling) break
    try {
      await bot.pathfinder.goto(new goals.GoalPlaceBlock(p.offset(0, 1, 0), bot.world, { range: 4 }))
      await bot.equip(sapling, 'hand')
      await bot.placeBlock(bot.blockAt(p), new Vec3(0, 1, 0))
      planted++
      used.push(p)
    } catch {}
  }
  if (planted) {
    town.data.saplingsPlanted += planted
    town.save()
    rec.event('plant', { count: planted, near: pos(center) })
  }
  return planted > 0
}

// 家の扉の前にチェストを置き、道具・防具・食べ物・苗木・少しの建材以外をしまう
export async function storeItems (bot, rec, town, craft) {
  const home = town.data.home
  if (!home) return false
  const chestId = bot.registry.blocksByName.chest.id
  let chest = town.data.chest ? bot.blockAt(new Vec3(town.data.chest.x, town.data.chest.y, town.data.chest.z)) : null
  if (!chest || chest.type !== chestId) {
    if (countItem(bot, 'chest') === 0 && !(await craft('chest', 1))) return false
    const spot = new Vec3(home.x + 1, home.y, home.z) // 扉の横（家の外）
    const ground = bot.blockAt(spot.offset(0, -1, 0))
    if (!ground || ground.boundingBox !== 'block') return false
    await bot.pathfinder.goto(new goals.GoalPlaceBlock(spot, bot.world, { range: 4 }))
    await bot.equip(bot.inventory.items().find((i) => i.name === 'chest'), 'hand')
    await bot.placeBlock(ground, new Vec3(0, 1, 0))
    chest = bot.blockAt(spot)
    if (!chest || chest.type !== chestId) return false
    town.data.chest = pos(spot)
    town.save()
    rec.event('build', { what: 'chest', at: pos(spot) })
  }

  await bot.pathfinder.goto(new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2))
  const keepCounts = { cobblestone: 32, dirt: 0 }
  const window = await bot.openContainer(chest)
  let moved = 0
  try {
    for (const item of bot.inventory.items()) {
      if (KEEP.test(item.name) || bot.registry.foodsByName[item.name]) continue
      const keep = keepCounts[item.name] ?? (/_planks$|_log$/.test(item.name) ? 16 : 0)
      const have = countItem(bot, item.name)
      const amount = Math.min(item.count, have - keep)
      if (amount <= 0) continue
      await window.deposit(item.type, null, amount).catch(() => {})
      moved += amount
    }
  } finally {
    window.close()
  }
  rec.event('store', { moved })
  return moved > 0
}

export async function goHome (bot, town) {
  const home = town.data.home
  if (!home) return false
  await bot.pathfinder.goto(new goals.GoalNear(home.x, home.y, home.z, 3))
  return true
}
