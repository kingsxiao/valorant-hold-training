import * as THREE from 'three'
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
    }
  }

  resetRound() {
    for (const b of this.bots) b.dispose() // 从场景移除并释放，防止网格无限累积
    this.bots.length = 0
    this.stats = this._freshStats()
    this.running = true
    this.roundEndAt = this.params.roundSeconds > 0 ? this.now() + this.params.roundSeconds : 0
    this.hold = { nextAt: 0, gapIdx: 0, fromLeft: true }
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

  // 架枪对枪：随机延迟 → 从缺口一侧拉出，横移穿过，概率性急停
  _stepHold(dt, ctx) {
    const h = this.hold
    const nowMs = this.now() * 1000
    if (h.nextAt === 0) {
      h.nextAt = nowMs + rand(this.params.delayMin, this.params.delayMax)
      h.gapIdx = Math.floor(Math.random() * this.map.gaps.length)
      h.fromLeft = Math.random() > 0.5
      return
    }
    const activeBot = this.bots.find(b => b.active && b.mode === 'peek')
    if (!activeBot && nowMs >= h.nextAt) {
      const gap = this.map.gaps[h.gapIdx]
      const b = this._bot()
      const startX = h.fromLeft ? gap.x0 - 2.2 : gap.x1 + 2.2
      const endX = h.fromLeft ? gap.x1 + 2.2 : gap.x0 - 2.2
      b.place(startX, this.map.peekLineZ, 'peek')
      b.gapName = gap.name
      b.peek = { startX, endX, dir: Math.sign(endX - startX), stopAt: rand(0.3, 0.7), stopped: false, stopUntil: 0 }
      h.nextAt = 0
      void ctx
    }
    if (activeBot?.peek) {
      const pk = activeBot.peek
      if (pk.stopUntil > this.now()) {
        activeBot.moveToward(0, dt) // 急停（counter-strafe）
      } else {
        activeBot.moveToward(pk.dir * CONFIG.bot.moveSpeed * this.params.speedMult, dt)
        // 经过急停点且未停过 → 概率急停一瞬
        const prog = Math.abs(activeBot.pos.x - pk.startX) / Math.abs(pk.endX - pk.startX)
        if (!pk.stopped && prog > pk.stopAt && Math.random() < CONFIG.training.peekStopChance) {
          pk.stopped = true
          pk.stopUntil = this.now() + rand(0.15, 0.35)
        }
        if ((pk.dir > 0 && activeBot.pos.x >= pk.endX) || (pk.dir < 0 && activeBot.pos.x <= pk.endX)) {
          activeBot.hide()
          if (!this.bots.some(b => b.active)) h.nextAt = this.now() * 1000 + rand(this.params.delayMin, this.params.delayMax)
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
      // 击杀确认：爆头击杀先"叮"再确认音（与游戏一致，爆头永远叮）；击杀音略延后让开层次
      if (zone === 'head') { this.audio.hitMark(true); this.audio.kill(0.06) }
      else this.audio.kill()
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
    bot.startDeath()
    // 短暂停顿后重新开始架枪
    this.hold.nextAt = this.now() * 1000 + 1200
  }

  registerShot() { this.stats.shots++ }
}
