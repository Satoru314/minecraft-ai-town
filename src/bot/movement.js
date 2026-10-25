// 移動の設定。ツルハシがない間は、移動のために石系のブロックを掘らない（素手だと遅いうえ何も得られない）。
import pathfinderPkg from 'mineflayer-pathfinder'
import { pos } from './util.js'

const { Movements } = pathfinderPkg
const NEEDS_PICKAXE = /pickaxe|incorrect_for_wooden_tool/

let current = null

export function updateMovements (bot) {
  const hasPickaxe = bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))
  if (current === hasPickaxe) return
  current = hasPickaxe

  const movements = new Movements(bot)
  movements.allowParkour = false
  movements.canOpenDoors = true
  // 泳いで渡るのは苦手なので、陸で回り込めるならそちらを選ばせる
  movements.liquidCost = 20
  if (!hasPickaxe) {
    for (const block of bot.registry.blocksArray) {
      if (NEEDS_PICKAXE.test(block.material ?? '')) movements.blocksCantBreak.add(block.id)
    }
  }
  bot.pathfinder.setMovements(movements)
}

// 地形の角に体が引っかかると、経路探索は「stuck → 再計算 → stuck」を延々と繰り返す。
// 同じ場所で2回引っかかったら、移動をいったん解除して、ランダムな向きにジャンプしながら少し進む。
export function installStuckRecovery (bot, rec) {
  let last = null
  let count = 0
  let recovering = false

  bot.on('path_reset', async (reason) => {
    if (reason !== 'stuck' || recovering) return
    const here = bot.entity.position
    count = last && last.distanceTo(here) < 1 ? count + 1 : 1
    last = here.clone()
    if (count < 2) return

    count = 0
    recovering = true
    bot.pathfinder.setGoal(null)
    try {
      const shore = bot.entity.isInWater ? findShore(bot) : null
      rec.event('unstuck', { at: pos(here), inWater: bot.entity.isInWater, shore: shore && pos(shore) })
      if (shore) {
        // 岸に向かってジャンプしながらまっすぐ泳ぐ
        for (let i = 0; i < 60 && bot.entity.isInWater; i++) {
          await bot.lookAt(shore.offset(0.5, 1.6, 0.5), true)
          bot.setControlState('forward', true)
          bot.setControlState('sprint', true)
          bot.setControlState('jump', true)
          await bot.waitForTicks(1)
        }
      } else {
        await bot.look(Math.random() * Math.PI * 2, 0, true)
        bot.setControlState('jump', true)
        bot.setControlState('forward', true)
        await bot.waitForTicks(10)
      }
    } finally {
      bot.clearControlStates()
      recovering = false
    }
  })
}

// 近くの「上に2マス空きがある固いブロック」= 立てる岸
function findShore (bot) {
  const me = bot.entity.position
  const candidates = bot.findBlocks({
    matching: (block) => block.boundingBox === 'block',
    maxDistance: 10,
    count: 400,
    useExtraInfo: (block) => {
      const a1 = bot.blockAt(block.position.offset(0, 1, 0))
      const a2 = bot.blockAt(block.position.offset(0, 2, 0))
      return a1?.boundingBox === 'empty' && a1.name !== 'water' && a2?.boundingBox === 'empty' && a2.name !== 'water'
    }
  }).filter((p) => p.y >= Math.floor(me.y) - 2 && p.y <= Math.floor(me.y) + 1)
  return candidates[0] ?? null
}

// 水の中では沈むと岸に上がれないので、ジャンプ（浮く）を押し続ける。
// pathfinder より後に登録するので、同じ tick ではこちらの指示が勝つ。
export function installSwimming (bot) {
  let swimming = false
  bot.on('physicsTick', () => {
    const inWater = bot.entity.isInWater
    if (inWater) {
      bot.setControlState('jump', true)
      swimming = true
    } else if (swimming) {
      bot.setControlState('jump', false)
      swimming = false
    }
  })
}

// サーバーに位置を引き戻され続ける（forcedMove が連続する）ことがある。
// 3秒に30回を超えたら移動をやめ、少し後ろに下がる。進行中の goto は失敗扱いになり、その目標はあきらめられる。
export function installRubberbandGuard (bot, rec) {
  const times = []
  let backing = false

  bot.on('forcedMove', async () => {
    const now = Date.now()
    times.push(now)
    while (times.length && now - times[0] > 3000) times.shift()
    if (times.length < 30 || backing) return

    times.length = 0
    backing = true
    rec.event('rubberband', { at: pos(bot.entity.position) })
    bot.pathfinder.setGoal(null)
    try {
      bot.setControlState('back', true)
      bot.setControlState('jump', true)
      await bot.waitForTicks(10)
    } finally {
      bot.clearControlStates()
      backing = false
    }
  })
}
