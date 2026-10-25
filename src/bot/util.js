export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function countItem (bot, name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
}

export function countMatching (bot, re) {
  return bot.inventory.items().filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0)
}

export function inventorySummary (bot) {
  const summary = {}
  for (const item of bot.inventory.items()) summary[item.name] = (summary[item.name] ?? 0) + item.count
  return summary
}

export function isNight (bot) {
  const t = bot.time.timeOfDay
  return t >= 12500 && t < 23500
}

export function pos (vec) {
  return { x: Math.round(vec.x), y: Math.round(vec.y), z: Math.round(vec.z) }
}
