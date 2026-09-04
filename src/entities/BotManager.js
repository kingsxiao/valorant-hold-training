import { Bot } from './Bot.js'
import { CONFIG } from '../core/Config.js'

// 纯架枪对枪训练：随机延迟后 Bot 从缺口拉出横移，玩家须在 aimTime 内击杀，否则判负
export const MODE_INFO = { label: '架枪对枪', desc: 'Bot 从缺口拉出 · 打慢了会被反杀' }

const rand = (a, b) => a + Math.random() * (b - a)

export class BotManager {
  constructor({ scene, world, map, audio, player }) {
    this.scene = scene; this.world = world; this.map = map
    this.audio = audio; this.player = player
    this.bots = []
    this.params = {
      delayMin: CONFIG.training.peekDelayMinMs,
      delayMax: CONFIG.training.peekDelayMaxMs,
      speedMult: 1.0,
      aimTimeMs: CONFIG.bot.aimTimeMs,
      roundSeconds: CONFIG.training.roundSeconds,
      rampUp: false, // 渐进难度：随击杀数缩短延迟/提升横移速度
      doubleGap: false, // 双缺口压力：A/B 缺口独立出人
    }
    this.onEvent = null // (type, data) → HUD 提示：'lost-duel' / 'killed' / 'round-end'
    this.stats = this._freshStats()
    this.roundEndAt = 0
    this.running = false
    this.t = 0 // 游戏时钟：只在 step 里累加 → ESC 暂停时回合计时/Bot 计时一并冻结
  }

  _freshStats() {
    return {
      shots: 0, hits: 0, headshots: 0, kills: 0, duelsLost: 0,
      reactions: [], // ms
      lastReaction: 0,
      maxStreak: 0,   // 本局最长连杀（4.5s 窗口），main 在击杀时更新
      aimErrors: [],  // 预瞄误差（度）：Bot 露头瞬间准星与目标的角偏差，Bot.step 采样
    }
  }

  resetRound() {
    for (const b of this.bots) b.dispose() // 从场景移除并释放，防止网格无限累积
    this.bots.length = 0
    this.stats = this._freshStats()
    this.running = true
    this.countdownUntil = this.now() + 3 // 开局 3s 倒计时：Bot 等 GO 再出，玩家可热身瞄点
    // 回合计时从 GO 之后才开始（倒计时是准备时间）
    this.roundEndAt = this.params.roundSeconds > 0
      ? this.countdownUntil + this.params.roundSeconds
      : 0
    this.hold = null // 惰性初始化：依赖 doubleGap 配置（单槽位 or A/B 双槽位）
    this.audio?.roundStart()
  }

  _bot() {
    let b = this.bots.find(x => !x.active && x.mode !== 'dying') // 复用已播完死亡动画的 Bot（隐藏后 mode 已归位 idle）
    if (!b) { b = new Bot(this.scene, this.world); b.manager = this; this.bots.push(b) }
    else { b.peek = null } // 清上一条命的管理器状态
    return b
  }

  now() { return this.t }

  // ---- 每个固定步长驱动 ----
  step(dt, alpha) {
    if (!this.running) return
    this.t += dt

    // 回合计时
    if (this.roundEndAt > 0 && this.now() >= this.roundEndAt) {
      this.running = false
      this.onEvent?.('round-end', this.stats)
      return
    }

    const ctx = { player: this.player, alpha, drive: null }
    this._stepHold(dt, ctx)

    // 脚步声由 Bot.step 内置（与步频同步的空间音），这里不再重复触发
    for (const b of this.bots) {
      if (b.active || b.mode === 'dying') b.step(dt, ctx)
    }

    // Bot 可见时间超过 aimTime → 判负
    for (const b of this.bots) {
      if (b.active && b.mode === 'peek' && b.visibleNow && b.firstVisibleAt > 0) {
        if ((this.now() - b.firstVisibleAt) * 1000 >= this.params.aimTimeMs) {
          this._loseDuel(b)
        }
      }
    }
  }

  // 渐进难度系数：每击杀延迟 ×0.93（下探到保底）、速度 ×1.02（封顶 1.3 倍）。
  // 越打越快逼出真实上限，也把"热身期"和"极限期"自然分开。
  get _rampKills() { return this.params.rampUp ? Math.min(this.stats.kills, 12) : 0 }
  get _rampDelay() { return Math.max(0.45, Math.pow(0.93, this._rampKills)) }
  get _rampSpeed() { return Math.min(1.3, this.params.speedMult * Math.pow(1.02, this._rampKills)) }

  // 架枪对枪调度：单缺口（随机 A/B）默认；双缺口压力模式下 A/B 各一个独立槽位，
  // B 起始错开 1.5s——练交叉火力下的目标选择与转火
  _initHold() {
    if (this.params.doubleGap) {
      return { slots: [0, 1].map(i => ({ gapIdx: i, nextAt: this.now() * 1000 + i * 1500, bot: null })) }
    }
    return { slots: [{ gapIdx: -1, nextAt: 0, bot: null }] } // gapIdx -1 = 每次随机缺口
  }

  _stepHold(dt, ctx) {
    if (this.now() < this.countdownUntil) return // 倒计时内不出人
    const h = this.hold ??= this._initHold()
    for (const slot of h.slots) this._stepSlot(slot, dt, ctx)
  }

  _stepSlot(slot, dt, ctx) {
    const nowMs = this.now() * 1000
    const activeBot = slot.bot && slot.bot.active && slot.bot.mode === 'peek' ? slot.bot : null

    if (slot.nextAt === 0) { // 未排程 → 按渐进难度随机下一次出现时间
      if (slot.gapIdx < 0) slot.gapIdx = Math.floor(Math.random() * this.map.gaps.length)
      const dMin = Math.max(250, this.params.delayMin * this._rampDelay)
      const dMax = Math.max(dMin + 100, this.params.delayMax * this._rampDelay)
      slot.nextAt = nowMs + rand(dMin, dMax)
      return
    }

    if (!activeBot && nowMs >= slot.nextAt) {
      const gap = this.map.gaps[slot.gapIdx]
      const b = this._bot()
      const fromLeft = Math.random() > 0.5
      const startX = fromLeft ? gap.x0 - 2.2 : gap.x1 + 2.2
      const endX = fromLeft ? gap.x1 + 2.2 : gap.x0 - 2.2
      b.place(startX, this.map.peekLineZ, 'peek')
      b.gapName = gap.name
      b.slot = slot
      // 35% 概率"露头即缩"（jiggle peek）：拉出到中段后折返缩回墙后，
      // 逼玩家守住准星等第二拉，而不是追着扫
      b.peek = {
        startX, endX, dir: Math.sign(endX - startX),
        stopAt: rand(0.3, 0.7), stopped: false, stopUntil: 0,
        retreatAt: Math.random() < 0.35 ? rand(0.45, 0.75) : 0, retreated: false,
      }
      slot.bot = b
      slot.nextAt = 0
      void ctx
      return
    }

    if (activeBot?.peek) {
      const pk = activeBot.peek
      if (pk.stopUntil > this.now()) {
        activeBot.moveToward(0, dt) // 急停（counter-strafe）
      } else {
        activeBot.moveToward(pk.dir * CONFIG.bot.moveSpeed * this._rampSpeed, dt)
        const span = Math.abs(pk.endX - pk.startX)
        if (span > 0.01) {
          // 经过急停点且未停过 → 概率急停一瞬
          const prog = Math.abs(activeBot.pos.x - pk.startX) / span
          if (!pk.stopped && prog > pk.stopAt && Math.random() < CONFIG.training.peekStopChance) {
            pk.stopped = true
            pk.stopUntil = this.now() + rand(0.15, 0.35)
          }
          // 到达缩回点 → 折返（缩回后终点=起点，走到底即 hide）
          if (pk.retreatAt && !pk.retreated && prog >= pk.retreatAt) {
            pk.retreated = true
            pk.endX = pk.startX
            pk.dir = -pk.dir
          }
        }
        if ((pk.dir > 0 && activeBot.pos.x >= pk.endX) || (pk.dir < 0 && activeBot.pos.x <= pk.endX)) {
          activeBot.hide()
          slot.bot = null
          slot.nextAt = 0 // 重新排程（渐进难度系数在排程时生效）
        }
      }
    }
  }

  // ---- 命中入口（WeaponSystem 调用）----
  pickHit(origin, dir, maxDist) {
    let best = null
    for (const b of this.bots) {
      if (!b.active && b.mode !== 'dying') continue
      const hit = b.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, best ? best.t : maxDist)
      if (hit) { hit.bot = b; best = hit }
    }
    return best
  }

  damage(bot, dmg, zone) {
    if (bot.invulnerable) return false
    // 反应时间：首次命中 - 首次可见
    if (bot.firstVisibleAt > 0 && this.stats.reactions.length < 500) {
      const ms = Math.round((this.now() - bot.firstVisibleAt) * 1000)
      if (ms >= 0 && ms < 3000) { this.stats.reactions.push(ms); this.stats.lastReaction = ms }
    }
    bot.hp -= dmg
    bot.flashHit(zone === 'head')
    this.stats.hits++
    if (zone === 'head') this.stats.headshots++
    if (bot.hp <= 0) {
      this.stats.kills++
      bot.startDeath()
      // 爆头击杀先"叮"（与游戏一致，爆头永远叮）；击杀确认音由 main 播放
      // （那里才知道连杀数 → 按连杀升调，层次不变）
      if (zone === 'head') this.audio.hitMark(true)
      this.onEvent?.('killed', { bot, zone })
      return true
    }
    this.audio.hitMark(zone === 'head')
    return false
  }

  _loseDuel(bot) {
    this.stats.duelsLost++
    // 敌方枪声从 Bot 位置响起（可听声辨位：死也要知道子弹从哪个缺口来的），随后受击/倒地
    this.audio.shot('rifle', { x: bot.pos.x, y: 1.3, z: bot.pos.z }, { pos: this.player.pos, yaw: this.player.yaw })
    this.player.onShot(100) // 致死伤害，内部已播放 hurt + death 音效
    this.onEvent?.('lost-duel', { bot })
    // Bot 开火视觉表现（枪口焰/曳光由 main 注入的 onBotFire 完成）→ 原地停留后缩回淡出
    this.onBotFire?.(bot)
    bot.startWon()
    // 该槽位短暂停顿后重新排程（双缺口模式下只停自己的槽位）
    if (bot.slot) bot.slot.nextAt = this.now() * 1000 + 1200
  }

  registerShot() { this.stats.shots++ }
}
