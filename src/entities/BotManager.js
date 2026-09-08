import { Bot } from './Bot.js'
import { CONFIG } from '../core/Config.js'

// 纯架枪对枪训练：随机延迟后 Bot 以两种姿势交替出掩体（连出两波同风格强制换）
// ——侧面跑过（贯穿缺口、顺跑向侧身入镜）或横向拉出（肩peek 面向玩家横移
// 拉出到窗口内急停对枪，含"露头即缩"变体）；玩家须在击杀时限
// 内命中——没打中 Bot 开火反击后跑向对面掩体，躲进墙后才出下一波（判负只进统计，
// 不弹提示；无伤害/死亡，训练不中断）
export const MODE_INFO = { label: '架枪对枪', desc: 'Bot 侧面跑过/横向拉出 · 没打中就继续打' }

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
      peekSide: CONFIG.training.peekSide, // Bot 出场侧：left/right 固定一侧，random 两侧随机
    }
    this.onEvent = null // (type, data) → HUD 提示：'killed' / 'round-end'
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
    this.hold = null // 惰性初始化：单缺口单槽位调度状态
    this.audio?.roundStart()
  }

  _bot() {
    let b = this.bots.find(x => !x.active && x.mode !== 'dying') // 复用已播完死亡动画的 Bot（隐藏后 mode 已归位 idle）
    if (!b) {
      b = new Bot(this.scene, this.world); b.manager = this; this.bots.push(b)
      // Bot 脚步声（空间化 HRTF）：墙后 Bot 拉出/跑过的方位信息——与步态
      // 落脚帧同拍触发（walkPhase 跨 π 检测），传连续速度（加速中脚步渐强）。
      // 倒地触地闷响：击杀的重量句点（ease-out 0.63 处的拍地帧触发）
      b.onFootstep = (speed) => {
        this.audio?.footstep(b.pos, { pos: this.player.pos, yaw: this.player.yaw }, speed >= 3.2, speed)
      }
      b.onDeathLand = () => {
        this.audio?.bodyDrop(b.pos, { pos: this.player.pos, yaw: this.player.yaw })
      }
    }
    else { b.peek = null } // 清上一条命的管理器状态
    return b
  }

  now() { return this.t }

  // 渲染帧视觉同步：Bot 网格位置按主循环 accumulator alpha 插值（与相机一致），
  // 由 main.renderFrame 每帧调用；sim step 内的写入只是兜底
  renderSync(alpha) {
    for (const b of this.bots) b.syncVisual(alpha)
  }

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

    const ctx = { player: this.player, alpha }
    this._stepHold(dt)

    // 脚步声由 Bot.step 内置（与步频同步的空间音），这里不再重复触发
    for (const b of this.bots) {
      if (b.active || b.mode === 'dying') b.step(dt, ctx)
    }

    // Bot 可见时间超过 aimTime → 判负（判负后 Bot 跑向对面掩体撤离，见 _loseDuel）
    for (const b of this.bots) {
      if (b.active && b.mode === 'peek' && !b.peek?.resolved && b.visibleNow && b.firstVisibleAt > 0) {
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

  // 架枪对枪调度：单缺口单槽位——每波走完缩回/对枪失败后按延迟区间重新排程
  _initHold() {
    return { slots: [{ nextAt: 0, bot: null }] }
  }

  _stepHold(dt) {
    if (this.now() < this.countdownUntil) return // 倒计时内不出人
    const h = this.hold ??= this._initHold()
    for (const slot of h.slots) this._stepSlot(slot, dt)
  }

  _stepSlot(slot, dt) {
    const nowMs = this.now() * 1000
    const activeBot = slot.bot && slot.bot.active && slot.bot.mode === 'peek' ? slot.bot : null

    if (slot.nextAt === 0) { // 未排程 → 按渐进难度随机下一次出现时间
      const dMin = Math.max(250, this.params.delayMin * this._rampDelay)
      const dMax = Math.max(dMin + 100, this.params.delayMax * this._rampDelay)
      slot.nextAt = nowMs + rand(dMin, dMax)
      return
    }

    if (!activeBot && nowMs >= slot.nextAt) {
      const gap = this.map.gaps[0]
      const b = this._bot()
      // 出场侧可设置：固定左/右练同向预瞄，random 保留两侧随机的读局训练
      const fromLeft = this.params.peekSide === 'random'
        ? Math.random() > 0.5
        : this.params.peekSide === 'left'
      // 每波二选一（训练两种读局情景，连出两波同风格后强制换另一种 ——
      // 两种姿势交替，不让随机连击把另一姿态连续藏几波）：
      //  cross 侧面跑过 —— 从墙后贯穿缺口跑到另一侧，身体顺跑向（旋转跑，侧身入镜）
      //  pull  横向拉出 —— 从墙后肩peek 拉出，面向玩家横移到窗口内急停对枪，之后缩回
      slot.lastStyles ??= []
      const lastTwo = slot.lastStyles.slice(-2)
      const cross = lastTwo.length === 2 && lastTwo[0] === lastTwo[1]
        ? lastTwo[0] !== 'cross'
        : Math.random() < CONFIG.training.crossChance
      let startX
      if (cross) {
        startX = fromLeft ? gap.x0 - 2.2 : gap.x1 + 2.2
        const endX = fromLeft ? gap.x1 + 2.2 : gap.x0 - 2.2
        b.peek = {
          style: 'cross', startX, endX, dir: Math.sign(endX - startX),
          stopAt: rand(0.3, 0.7), stopped: false, stopUntil: 0,
        }
      } else {
        const dir = fromLeft ? 1 : -1                       // 朝缺口内的拉出方向
        const edge = fromLeft ? gap.x0 : gap.x1             // 从这一侧的墙后拉出
        startX = edge - dir * rand(1.8, 2.4)                // 藏在墙后一点（留出加速距离）
        const holdX = (gap.x0 + gap.x1) / 2 - dir * rand(0, 0.9) // 停在窗口内、略偏拉出侧（贴掩体对枪）
        // 拉出波的一部分是"露头即缩"jiggle-peek：拉到中段（已可见）立即折返，逼玩家守准星
        const jiggleAt = Math.random() < CONFIG.training.pullJiggleChance
          ? startX + dir * rand(0.5, 0.72) * Math.abs(holdX - startX)
          : 0
        b.peek = { style: 'pull', startX, holdX, endX: startX, dir, phase: 'out', holdUntil: 0, jiggleAt }
      }
      b.place(startX, this.map.peekLineZ, 'peek')
      b.slot = slot
      slot.bot = b
      slot.nextAt = 0
      slot.lastStyles.push(b.peek.style)
      if (slot.lastStyles.length > 2) slot.lastStyles.shift() // 只留最近两条防连击判断
      return
    }

    if (activeBot?.peek) {
      const pk = activeBot.peek
      const speed = CONFIG.bot.moveSpeed * this._rampSpeed
      if (pk.stopUntil > this.now()) {
        activeBot.moveToward(0, dt) // 急停（counter-strafe）
      } else if (pk.style === 'pull') {
        // 拉出状态机：out（拉出到窗口）→ hold（站定对枪，胜负由可见时限判定）
        // → leave（向 exitX 撤离：常规缩回原掩体；判负后改为跑向对面掩体）
        if (pk.phase === 'out') {
          activeBot.moveToward(pk.dir * speed, dt)
          const target = pk.jiggleAt || pk.holdX
          const reached = pk.dir > 0 ? activeBot.pos.x >= target : activeBot.pos.x <= target
          if (reached) {
            if (pk.jiggleAt) { pk.phase = 'leave'; pk.exitX = pk.startX } // 露头即缩：直接折返
            else { pk.phase = 'hold'; pk.holdUntil = this.now() + CONFIG.training.pullHoldMaxMs / 1000 }
          }
        } else if (pk.phase === 'hold') {
          activeBot.moveToward(0, dt) // counter-strafe 站定对枪；holdUntil 只是兜底（LOS 断了也不挂场）
          if (this.now() >= pk.holdUntil) { pk.phase = 'leave'; pk.exitX = pk.startX }
        } else {
          const d = Math.sign(pk.exitX - activeBot.pos.x) || 1
          activeBot.moveToward(d * speed, dt)
          const done = d > 0 ? activeBot.pos.x >= pk.exitX : activeBot.pos.x <= pk.exitX
          if (done) {
            activeBot.hide()
            slot.bot = null
            slot.nextAt = 0 // 躲进墙后才重新排程下一波
          }
        }
      } else {
        // cross：贯穿横移 + 概率急停一瞬（急停时 Bot 转回面向玩家 = 停步挑战；
        // 已判负的 Bot 一路跑向对面掩体，不再停步）
        activeBot.moveToward(pk.dir * speed, dt)
        const span = Math.abs(pk.endX - pk.startX)
        if (span > 0.01) {
          const prog = Math.abs(activeBot.pos.x - pk.startX) / span
          if (!pk.stopped && !pk.resolved && prog > pk.stopAt && Math.random() < CONFIG.training.peekStopChance) {
            pk.stopped = true
            pk.stopUntil = this.now() + rand(0.15, 0.35)
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
    if (bot.mode === 'dying') return false // 倒地动画中的尸体不可再伤害（重复计击杀/重启动画）
    // 反应时间：首次命中 - 首次可见（每次出场只记一条：多发击杀的第一发才是"反应"，
    // 后续弹只是补伤害，计入会把均值拖慢、最快反应刷假纪录）
    if (bot.firstVisibleAt > 0 && !bot.reactRecorded && this.stats.reactions.length < 500) {
      const ms = Math.round((this.now() - bot.firstVisibleAt) * 1000)
      if (ms >= 0 && ms < 3000) { this.stats.reactions.push(ms); this.stats.lastReaction = ms }
      bot.reactRecorded = true
    }
    bot.hp -= dmg
    // 伤害力度归一（55 伤=1）：踉跄幅度/命中火花密度共用的力度因子
    const power = Math.min(1.4, Math.max(0.4, dmg / 55))
    bot.flashHit(zone === 'head', power)
    this.stats.hits++
    if (zone === 'head') this.stats.headshots++
    if (bot.hp <= 0) {
      this.stats.kills++
      bot.startDeath()
      // 击杀时的爆头"叮"由 main 播（那里才知道连杀数 → 按连杀升调，与击杀
      // 确认音同一 pitch 阶梯）；未击杀命中的叮仍在下方（基础音高）
      this.onEvent?.('killed', { bot, zone })
      return true
    }
    this.audio.hitMark(zone === 'head')
    return false
  }

  _loseDuel(bot) {
    this.stats.duelsLost++
    // 敌方枪声从 Bot 位置响起（可听声辨位：输了也要知道子弹从哪个缺口来的）。
    // 纯架枪训练无受伤设定：无受击音/红闪/方向弧，玩家不掉血、继续架枪
    this.audio.shot('rifle', { x: bot.pos.x, y: 1.3, z: bot.pos.z }, { pos: this.player.pos, yaw: this.player.yaw })
    this.onBotFire?.(bot) // 开火视觉表现（枪口焰/曳光由 main 注入）
    // 不弹"对枪失败"提示、不原地淡出：Bot 跑向对面掩体撤离，躲进墙后
    // 下一波才出（判负只进统计面板）。之后的补枪也不算反应样本
    bot.reactRecorded = true
    const pk = bot.peek
    if (!pk) return
    pk.resolved = true // 对枪已判定：Bot 保持 peek 模式跑完全程，不再重复触发判负
    if (pk.style === 'pull') {
      const gap = this.map.gaps[0]
      pk.exitX = pk.dir > 0 ? gap.x1 + 2.2 : gap.x0 - 2.2 // 对面掩体后
      pk.phase = 'leave'
    }
    // cross 本就贯穿缺口：endX 已是对面掩体，继续跑完即可
  }

  // 地图重建（缺口左右切换）后：场上 Bot 的横移线还是旧缺口的，
  // 就地回收并重排下一波——不走完旧线（会从已封死的墙段里穿出来）
  onMapRebuilt() {
    for (const slot of this.hold?.slots ?? []) { slot.bot = null; slot.nextAt = 0 }
    for (const b of this.bots) {
      if (b.active && b.mode === 'peek') b.hide()
    }
  }

  // 敌方闪光起爆后由 main 调用："闪拉"配合——下一波 peek 提前到起爆后 ~0.5-1s
  // （本波已在场的让它演完，只影响未排程/晚排程的槽位）
  urgeNextPeek(afterSec = 0.8) {
    const h = this.hold
    if (!h || this.now() < this.countdownUntil) return
    const target = (this.now() + afterSec) * 1000
    for (const slot of h.slots) {
      if (slot.bot?.active) continue
      slot.nextAt = Math.min(slot.nextAt > 0 ? slot.nextAt : Infinity, target)
    }
  }

  registerShot() { this.stats.shots++ }
}
