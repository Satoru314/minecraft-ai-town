// bot 本体。接続して、反射・行動・記録を動かす。
// 切断されたら終了し、再接続は systemd（Restart=always）に任せる。
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import pvpPkg from 'mineflayer-pvp'
import armorManager from 'mineflayer-armor-manager'
import collectBlockPkg from 'mineflayer-collectblock'
import { loader as autoEat } from 'mineflayer-auto-eat'
import { createRecorder } from './record.js'
import { startReflexes } from './reflexes.js'
import { runActivity } from './activity.js'
import { inventorySummary, isNight, pos } from './util.js'

const { pathfinder, Movements, goals } = pathfinderPkg

const config = {
  host: process.env.MC_HOST,
  port: Number(process.env.MC_PORT ?? 25565),
  version: process.env.MC_VERSION ?? '26.1.2',
  username: process.env.BOT_NAME ?? 'ai_builder_01',
  dataDir: process.env.DATA_DIR ?? './data'
}
if (!config.host) {
  console.error('MC_HOST is not set')
  process.exit(2)
}

const rec = createRecorder(config.dataDir)
const saved = rec.readState()
const ctx = {
  reflex: null, // fight / flee / sheltering / shelter / leaving_shelter / night_no_shelter
  task: null,
  paused: false,
  deaths: saved.deaths ?? 0,
  aliveSince: saved.aliveSince ?? new Date().toISOString()
}

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  version: config.version,
  username: config.username,
  auth: 'offline'
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(pvpPkg.plugin)
bot.loadPlugin(armorManager)
bot.loadPlugin(collectBlockPkg.plugin)
bot.loadPlugin(autoEat)

bot.once('spawn', async () => {
  // spawn 直後は周りのチャンクが届いていないので、待ってから動き出す
  await bot.waitForChunksToLoad()
  const movements = new Movements(bot)
  movements.allowParkour = false
  movements.canOpenDoors = true
  bot.pathfinder.setMovements(movements)
  bot.autoEat.enableAuto()

  rec.event('connected', { at: pos(bot.entity.position), version: bot.version })
  startReflexes(bot, ctx, rec)
  runActivity(bot, ctx, rec).catch((err) => rec.event('activity_crashed', { error: err.message }))
  setInterval(writeState, 5000)
})

// 死亡メッセージ（「ai_builder_01 was slain by Zombie」など）から死因を拾う
let lastDeathMessage = null
bot.on('messagestr', (message, position) => {
  if (position !== 'chat' && message.startsWith(bot.username + ' ')) lastDeathMessage = message
})
bot.on('death', () => {
  ctx.deaths++
  const lived = (Date.now() - new Date(ctx.aliveSince).getTime()) / 60000
  rec.event('death', { cause: lastDeathMessage, at: pos(bot.entity.position), livedMinutes: Math.round(lived) })
  ctx.aliveSince = new Date().toISOString()
  lastDeathMessage = null
})

// チャットでのお願い（人間のプレイヤーから）
bot.on('chat', (username, message) => {
  if (username === bot.username) return
  const text = message.trim()
  if (/^(来て|きて|come)$/i.test(text)) {
    const player = bot.players[username]?.entity
    if (!player) return bot.chat('見えないよ。近くに来て')
    ctx.paused = true
    bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true)
    bot.chat('行くね')
  } else if (/^(止まって|とまって|stop)$/i.test(text)) {
    ctx.paused = true
    bot.collectBlock.cancelTask().catch(() => {})
    bot.pathfinder.stop()
    bot.chat('止まった')
  } else if (/^(再開|続けて|resume)$/i.test(text)) {
    ctx.paused = false
    bot.pathfinder.stop()
    bot.chat('作業に戻るね')
  } else if (/^(状況|status)$/i.test(text)) {
    bot.chat(`HP ${Math.round(bot.health)} / 満腹度 ${bot.food} / 今: ${ctx.reflex ?? ctx.task ?? '待機'} / 死亡 ${ctx.deaths}回`)
  } else {
    return
  }
  rec.event('chat_command', { from: username, text })
})

function writeState () {
  if (!bot.entity) return
  rec.writeState({
    updatedAt: new Date().toISOString(),
    name: bot.username,
    position: pos(bot.entity.position),
    dimension: bot.game.dimension,
    health: bot.health,
    food: bot.food,
    timeOfDay: bot.time.timeOfDay,
    night: isNight(bot),
    reflex: ctx.reflex,
    task: ctx.task,
    paused: ctx.paused,
    deaths: ctx.deaths,
    aliveSince: ctx.aliveSince,
    inventory: inventorySummary(bot),
    players: Object.keys(bot.players).filter((n) => n !== bot.username)
  })
}

bot.on('kicked', (reason) => rec.event('kicked', { reason: typeof reason === 'string' ? reason : JSON.stringify(reason) }))
bot.on('error', (err) => rec.event('error', { error: err.message }))
bot.on('end', (reason) => {
  rec.event('disconnected', { reason })
  process.exit(1)
})
