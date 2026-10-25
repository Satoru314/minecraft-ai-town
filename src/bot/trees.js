// 木を根元から丸ごと切り倒す。手が届かない高さは、幹のあった場所に足場を積んで登って切る。
// 葉は幹がなくなれば自然に消えて苗木を落とすので、切らない。
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { pos, sleep } from './util.js'

const { goals } = pathfinderPkg

export const LOG_RE = /^(?!stripped_).*_(log|stem)$/
const REACH = 4.2
const MAX_LOGS = 80
const MAX_SPREAD = 5 // 根元から横にこれ以上離れた丸太は別の木とみなす

const isLog = (b) => !!b && LOG_RE.test(b.name)

// 根元の丸太 = 下が丸太ではない固いブロックの丸太
export function isTreeBase (bot, p) {
  const below = bot.blockAt(p.offset(0, -1, 0))
  return !!below && !isLog(below) && below.boundingBox === 'block'
}

// 根元からつながっている丸太（幹と枝）。下から順
export function connectedLogs (bot, base, isProtected = () => false) {
  const seen = new Set([base.toString()])
  const queue = [base]
  const logs = []
  while (queue.length && logs.length < MAX_LOGS) {
    const p = queue.shift()
    logs.push(p)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const n = p.offset(dx, dy, dz)
          const key = n.toString()
          if (seen.has(key)) continue
          seen.add(key)
          if (Math.abs(n.x - base.x) > MAX_SPREAD || Math.abs(n.z - base.z) > MAX_SPREAD) continue
          if (isProtected(n) || !isLog(bot.blockAt(n))) continue
          queue.push(n)
        }
      }
    }
  }
  return logs.sort((a, b) => a.y - b.y)
}

function eyeDistance (bot, p) {
  return bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5))
}

export async function fellTree (bot, rec, base, { stop = () => false, isProtected = () => false } = {}) {
  const logs = connectedLogs(bot, base, isProtected)
  let cut = 0
  for (const p of logs) {
    if (stop()) break
    const block = bot.blockAt(p)
    if (!isLog(block)) continue
    if (eyeDistance(bot, p) > REACH) {
      // 届かなければ近づく。高いところは幹の列に足場を積んで登る
      try {
        await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y - 2, p.z, 1))
      } catch {}
      if (eyeDistance(bot, p) > REACH + 0.5) continue
    }
    try {
      if (bot.tool) await bot.tool.equipForBlock(block, {})
      await bot.dig(block)
      cut++
    } catch {}
  }

  // 降りて、落ちた原木や苗木を拾う
  await bot.pathfinder.goto(new goals.GoalNear(base.x, base.y, base.z, 1)).catch(() => {})
  await sleep(800)
  const drops = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(base) < 8)
  for (const item of drops) {
    if (stop()) break
    await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5)).catch(() => {})
  }
  if (cut) rec.event('fell_tree', { at: pos(base), logs: cut, of: logs.length })
  return cut
}
