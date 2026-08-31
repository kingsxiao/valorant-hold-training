import * as THREE from 'three'
import { Bot } from './Bot.js'
import { CONFIG } from '../core/Config.js'

// 训练模式管理器
//  range  靶场       多个静态靶，击杀后延时重生（练定位/预瞄）
//  hold   架枪对枪   随机延迟后 Bot 从缺口拉出横移，玩家须在 aimTime 内击杀，否则判负
//  flick  快速拉枪   目标随机出现在前方扇区，限时站立
//  spray  压枪       正前方固定靶连续重生（配合曳光/弹孔校准弹道）
//  track  跟枪       目标全速左右横移（随机变向），练跟枪
export const MODES = {
  range: { label: '靶场预瞄', desc: '静态靶 · 击杀后重生' },
  hold: { label: '架枪对枪', desc: 'Bot 从缺口拉出 · 打慢了会被反杀' },
  flick: { label: '快速拉枪', desc: '目标随机出现 · 练甩枪' },
  spray: { label: '压枪训练', desc: '连续扫射固定靶 · 看弹孔校弹道' },
  track: { label: '跟枪训练', desc: '全速横移目标 · 练跟踪' },
}

const rand = (a, b) => a + Math.random() * (b - a)

export class BotManager {
  constructor({ scene, world, map, audio, player }) {
    this.scene = scene; this.world = world; this.map = map
    this.audio = audio; this.player = player
    this.bots = []
    this.mode = 'hold'
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

  setMode(mode) {
    this.mode = mode
    this.resetRound()
  }

  resetRound() {
    for (const b of this.bots) b.dispose() // 从场景移除并释放，防止网格无限累积
    this.bots.length = 0
    this.stats = this._freshStats()
    this.running = true
    this.roundEndAt = this.params.roundSeconds > 0 ? this.now() + this.params.roundSeconds : 0
    this.hold = { nextAt: 0, gapIdx: 0, fromLeft: true }
    this.track = { dir: 1, nextFlipAt: 0 }
    // 各模式首次布场
    if (this.mode === 'range') this._spawnRange()
    else if (this.mode === 'spray') this._spawnSpray()
    else if (this.mode === 'track') this._spawnTrack()
    else if (this.mode === 'flick') { this.flickUntil = 0; this.hold.nextAt = 0 }
    this.audio?.roundStart()
  }

  _bot() {
    let b = this.bots.find(x => !x.active && x.mode !== 'dying') // 复用已播完死亡动画的 Bot（隐藏后 mode 已归位 idle）
    if (!b) { b = new Bot(this.scene, this.world); b.manager = this; this.bots.push(b) }
    else { b.flickDieAt = 0; b.respawnAt = 0; b.peek = null } // 清上一条命的管理器状态
    return b
  }

  now() { return this.t }

  _spawnRange() {
    for (const stand of this.map.rangeStands) {
      const b = this._bot()
      b.place(stand.x, stand.z, 'idle')
      b.home = { x: stand.x, z: stand.z }
    }
  }

  _spawnSpray() {
    const b = this._bot()
    b.place(12, -12, 'idle')   // 压枪墙前
    b.home = { x: 12, z: -12 }
  }

  _spawnTrack() {
    const b = this._bot()
    b.place(0, -16, 'track')
    b.trackCenter = 0
    this.track = { dir: Math.random() > 0.5 ? 1 : -1, nextFlipAt: this.now() + rand(0.4, 1.2) }
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

    const ctx = { player: this.player, alpha, drive: null }

    // 靶场/压枪模式：死亡目标延时重生（死亡动画播完 hide 后 mode 已归位，靠 respawnAt 找回）
    if (this.mode === 'range' || this.mode === 'spray') {
      for (const b of this.bots) {
        if (!b.active && b.respawnAt && this.now() >= b.respawnAt) {
          b.place(b.home.x, b.home.z, 'idle')
          b.respawnAt = 0
        }
      }
    }

    switch (this.mode) {
      case 'hold': this._stepHold(dt, ctx); break
      case 'flick': this._stepFlick(dt, ctx); break
      case 'track': this._stepTrack(dt, ctx); break
    }

    for (const b of this.bots) {
      if (b.active || b.mode === 'dying') b.step(dt, ctx)
    }

    // 架枪模式：Bot 可见时间超过 aimTime → 判负
    if (this.mode === 'hold') {
      for (const b of this.bots) {
        if (b.active && b.mode === 'peek' && b.visibleNow && b.firstVisibleAt > 0) {
          if ((this.now() - b.firstVisibleAt) * 1000 >= this.params.aimTimeMs) {
            this._loseDuel(b)
          }
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
      h.stopped = false
      return
    }
    const activeBot = this.bots.find(b => b.active && b.mode === 'peek')
    if (!activeBot && nowMs >= h.nextAt) {
      const gap = this.map.gaps[h.gapIdx]
      const b = this._bot()
      const startX = h.fromLeft ? gap.x0 - 2.2 : gap.x1 + 2.2
      const endX = h.fromLeft ? gap.x1 + 2.2 : gap.x0 - 2.2
      b.place(startX, this.map.peekLineZ, 'peek')
      b.peek = { startX, endX, dir: Math.sign(endX - startX), stopAt: rand(0.3, 0.7), stopped: false, stopUntil: 0 }
      h.nextAt = 0
      // 站位提醒：远离缺口时提示
      void ctx
    }
    if (activeBot) {
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

  _stepFlick(dt, ctx) {
    const h = this.hold
    const count = CONFIG.training.flickCount
    const activeCount = this.bots.filter(b => b.active).length
    if (activeCount < count && this.now() >= (h.nextAt ?? 0)) {
      // 在玩家前方 ±60°、8~26m 的空地随机出生（避开掩体：失败重试）
      // 朝向 yaw 的前向为 (−sin yaw, −cos yaw)，扇区 = yaw ± 1.05rad
      const p = this.player
      for (let tries = 0; tries < 20; tries++) {
        const ang = p.yaw + rand(-1.05, 1.05)
        const d = rand(8, 26)
        const x = p.pos.x - Math.sin(ang) * d
        const z = p.pos.z - Math.cos(ang) * d
        if (x < -15 || x > 15 || z < -44 || z > 7) continue
        // 不许出生在掩体里
        if (!this.world.lineOfSight(p.pos.x, p.pos.y + 1.6, p.pos.z, x, 1.5, z)) continue
        const b = this._bot()
        b.place(x, z, 'idle')
        b.flickDieAt = this.now() + 2.2
        break
      }
      h.nextAt = this.now() + 0.25
    }
    for (const b of this.bots) {
      if (b.active && b.flickDieAt && this.now() > b.flickDieAt) {
        b.flickDieAt = 0
        b.startDeath()
        this.hold.nextAt = this.now() + 0.6
      }
    }
  }

  _stepTrack(dt, ctx) {
    const t = this.track
    const b = this.bots.find(b => b.active && b.mode === 'track')
    if (!b) {
      // 目标死亡：等死亡动画播完（mode 归位 idle）后重生
      const dying = this.bots.some(x => x.active && x.mode === 'dying')
      if (!dying) this._spawnTrack()
      return
    }
    if (this.now() >= t.nextFlipAt) {
      t.dir = -t.dir
      t.nextFlipAt = this.now() + rand(0.5, 1.4)
    }
    // 到边界强制折返
    if (b.pos.x < -13) t.dir = 1
    if (b.pos.x > 13) t.dir = -1
    b.moveToward(t.dir * CONFIG.bot.moveSpeed * this.params.speedMult, dt)
    // 朝向由 Bot.step 统一处理（移动朝行进方向、静止朝玩家，带平滑转身）
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
      bot.respawnAt = this.now() + 1.2
      this.audio.kill()
      this.onEvent?.('killed', { bot, zone })
      return true
    }
    this.audio.hitMark(zone === 'head')
    return false
  }

  _loseDuel(bot) {
    this.stats.duelsLost++
    this.player.onShot(100) // 致死伤害，内部已播放 hurt + death 音效
    this.onEvent?.('lost-duel', { bot })
    bot.startDeath()
    // 短暂停顿后重新开始架枪
    this.hold.nextAt = this.now() * 1000 + 1200
  }

  registerShot() { this.stats.shots++ }
}
