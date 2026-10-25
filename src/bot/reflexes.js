// 反射: 判断モデルに聞かず、その場で処理するもの（戦闘・逃走・夜の避難）。
// 食事 (mineflayer-auto-eat) と防具 (mineflayer-armor-manager) はプラグインに任せる。
import pathfinderPkg from 'mineflayer-pathfinder'
import { isNight, pos, sleep } from './util.js'

const { goals } = pathfinderPkg

const FIGHT_RANGE = 10
const FLEE_HEALTH = 7
// 弓を持つ敵からは、背中を向けて逃げると撃たれ続ける。かなり危なくなるまで詰め寄って倒す
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager'])
const FLEE_HEALTH_RANGED = 4
const IGNORE = new Set(['enderman', 'zombified_piglin', 'piglin'])
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe']
const SHELTER_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks']

function isHostile (entity) {
  return (entity.type === 'hostile' || entity.kind === 'Hostile mobs') && !IGNORE.has(entity.name)
}

function hasWeapon (bot) {
  return bot.inventory.items().some((i) => WEAPONS.includes(i.name))
}

async function equipBestWeapon (bot) {
  for (const name of WEAPONS) {
    const item = bot.inventory.items().find((i) => i.name === name)
    if (item) {
      await bot.equip(item, 'hand').catch(() => {})
      return
    }
  }
}

export function startReflexes (bot, ctx, rec) {
  let fightTarget = null
  let shelterFrom = null // 避難前に立っていた地上の位置

  async function interruptActivity () {
    if (bot.collectBlock) await bot.collectBlock.cancelTask().catch(() => {})
    bot.pathfinder.setGoal(null)
  }

  function nearestThreat () {
    const me = bot.entity.position
    return bot.nearestEntity((e) =>
      isHostile(e) &&
      e.position.distanceTo(me) < FIGHT_RANGE &&
      Math.abs(e.position.y - me.y) < 4)
  }

  async function fightOrFlee () {
    const threat = nearestThreat()

    if (!threat) {
      if (ctx.reflex === 'fight' || ctx.reflex === 'flee') {
        bot.pvp.stop()
        bot.pathfinder.setGoal(null)
        ctx.reflex = shelterFrom ? 'shelter' : null
      }
      return
    }
    // 避難中は穴の中にいるので、すぐそばまで来たときだけ戦う
    if (shelterFrom && threat.position.distanceTo(bot.entity.position) > 3) return

    const fleeAt = RANGED.has(threat.name) ? FLEE_HEALTH_RANGED : FLEE_HEALTH
    const tooWeak = bot.health <= fleeAt || (threat.name === 'creeper' && !hasWeapon(bot))
    if (tooWeak) {
      if (ctx.reflex !== 'flee') {
        ctx.reflex = 'flee'
        bot.pvp.stop()
        await interruptActivity()
        rec.event('flee', { from: threat.name, health: bot.health, at: pos(bot.entity.position) })
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(threat, 20)), true)
      }
      return
    }

    if (ctx.reflex !== 'fight' || fightTarget !== threat) {
      const wasActive = !ctx.reflex
      ctx.reflex = 'fight'
      fightTarget = threat
      if (wasActive) await interruptActivity()
      await equipBestWeapon(bot)
      rec.event('fight', { target: threat.name, health: bot.health, at: pos(bot.entity.position) })
      bot.pvp.attack(threat)
    }
  }

  bot.on('entityDead', (entity) => {
    if (entity === fightTarget) {
      rec.event('kill', { target: entity.name })
      fightTarget = null
    }
  })

  // 夜は足元を3ブロック掘って潜り、頭の上をふさぐ
  async function shelter () {
    const start = bot.entity.position.floored()
    for (let dy = 1; dy <= 3; dy++) {
      const below = bot.blockAt(start.offset(0, -dy, 0))
      const under = bot.blockAt(start.offset(0, -dy - 1, 0))
      if (!below || !under || ['lava', 'water', 'bedrock'].includes(below.name) ||
          ['lava', 'water', 'air', 'cave_air'].includes(under.name)) {
        rec.event('shelter_failed', { reason: `unsafe below (${below?.name}/${under?.name})`, at: pos(start) })
        return false
      }
      // 縦穴の横に水や溶岩があると、掘ったとたんに流れ込んでくる
      const side = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dz]) => bot.blockAt(start.offset(dx, -dy, dz))?.name)
        .find((name) => name === 'water' || name === 'lava')
      if (side) {
        rec.event('shelter_failed', { reason: `${side} next to the shaft`, at: pos(start) })
        return false
      }
      // 持っている中で一番合う道具に持ち替えてから、時間がかかりすぎないか見る（素手で石、など）
      if (bot.tool) await bot.tool.equipForBlock(below, {}).catch(() => {})
      if (bot.digTime(below) > 5000) {
        rec.event('shelter_failed', { reason: `too slow to dig ${below.name} (${Math.round(bot.digTime(below))}ms, onGround=${bot.entity.onGround})`, at: pos(start) })
        return false
      }
      await bot.dig(below)
      await sleep(400)
    }
    // 落ちた先で、頭上（地表から1ブロック下）をふさぐ
    const roof = start.offset(0, -1, 0)
    const blockItem = bot.inventory.items().find((i) => SHELTER_BLOCKS.includes(i.name))
    if (blockItem) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ref = bot.blockAt(roof.offset(dx, 0, dz))
        if (ref && ref.boundingBox === 'block') {
          await bot.equip(blockItem, 'hand')
          await bot.placeBlock(ref, roof.minus(ref.position)).catch(() => {})
          break
        }
      }
    }
    shelterFrom = start
    rec.event('shelter', { at: pos(start), roofed: !!blockItem })
    return true
  }

  async function leaveShelter () {
    const target = shelterFrom
    shelterFrom = null
    ctx.reflex = 'leaving_shelter'
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(target.x, target.y, target.z))
      rec.event('left_shelter', { at: pos(bot.entity.position) })
    } catch (err) {
      rec.event('left_shelter', { at: pos(bot.entity.position), error: err.message })
    }
    ctx.reflex = null
  }

  // 夜にどう過ごすかは判断係が選ぶ（穴を掘る・家に帰る・寝る・そのまま働く）。ここでは穴にこもった後始末だけをする
  async function shelterCheck () {
    if (!shelterFrom || ctx.reflex === 'fight' || ctx.reflex === 'flee' || ctx.reflex === 'leaving_shelter') return
    // 穴に水が入ってきたら、夜でもすぐ出る
    if (bot.entity.isInWater || bot.oxygenLevel < 18) {
      rec.event('shelter_flooded', { oxygen: bot.oxygenLevel, at: pos(bot.entity.position) })
      await leaveShelter()
      return
    }
    if (!isNight(bot)) await leaveShelter()
  }

  // 判断係が「穴を掘ってこもる」を選んだときに呼ぶ。こもっている間（ctx.reflex = 'shelter'）は朝まで行動が止まる
  ctx.digIn = async () => {
    ctx.reflex = 'sheltering'
    const ok = await shelter().catch((err) => {
      rec.event('shelter_failed', { reason: err.message, at: pos(bot.entity.position) })
      return false
    })
    ctx.reflex = ok ? 'shelter' : null
    return ok
  }

  let busy = false
  const timer = setInterval(async () => {
    if (busy || !bot.entity || !(bot.health > 0)) return
    busy = true
    try {
      await fightOrFlee()
      await shelterCheck()
    } catch (err) {
      rec.event('reflex_error', { error: err.message })
    } finally {
      busy = false
    }
  }, 500)

  bot.on('death', () => {
    shelterFrom = null
    fightTarget = null
    ctx.reflex = null
  })
  bot.once('end', () => clearInterval(timer))
}
