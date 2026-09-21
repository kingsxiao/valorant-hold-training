import { Bot } from './Bot.js'
import { CROUCH_WALK_SPEED } from '../core/Locomotion.js'
import { CONFIG } from '../core/Config.js'

// 纯架枪训练：三段式随机延迟（快速补拉/短段/长段）后 Bot 以两种节奏出掩体
// （连出两波同风格强制换），偶发双拉波——同一波两人锁步拉出（模拟双拉转火）。
// ——贯穿跑过（面向玩家横移贯穿缺口）或拉出即缩（面向玩家横移拉到折返点即
// 缩回，含"露头即缩"变体）。全程面朝玩家、不开枪、不跳、不停顿——纯移动靶
// 练习，漏掉的 Bot（完整走完波次未被击杀）只进统计
export const MODE_INFO = { label: '架枪对枪' }

const rand = (a, b) => a + Math.random() * (b - a)

// 池调度纯逻辑：池未满 → null（新建，每只 Bot 构造时随机抽一名英雄，cap 只
// 覆盖全英雄池）；池满 → 优先从休眠 Bot 中随机挑一只复用（出场英雄波次轮换）；
// 休眠全无但有尸体（本体击杀表现：尸体整局留存）→ 回收最老的一具顶替出场，
// 池大小保持稳定。cap=1（单模板/程序化假人）时随机区间收缩为唯一一只 = 原
// 「复用第一只」行为
export function pickIdleBot(idle, corpses = [], poolSize, cap, random = Math.random) {
  if (poolSize < cap) return null
  if (idle.length) return idle[Math.floor(random() * idle.length)]
  if (!corpses.length) return null
  return corpses.reduce((oldest, b) => (b.corpseAt < oldest.corpseAt ? b : oldest))
}

// 双拉第二人波次规格：整条横移线路沿行进方向平移 off（起点/折返/终点/jiggle
// 折返点一起搬），速度与风格全同 → 两人在场上锁步跟随、路径平行永不交叉穿模。
// 展开成新对象（不共享引用）：pull 的 phase/exitX 会被各自波次原地改写
export function shiftPeek(pk, off) {
  const s = { ...pk, startX: pk.startX + off }
  if (pk.style === 'cross') s.endX = pk.endX + off
  else {
    s.turnX = pk.turnX + off
    s.endX = pk.endX + off
    if (pk.jiggleAt) s.jiggleAt = pk.jiggleAt + off
  }
  return s
}

export class BotManager {
  constructor({ scene, world, map, audio, player }) {
    this.scene = scene; this.world = world; this.map = map
    this.audio = audio; this.player = player
    this.bots = []
    this.params = {
      delayMin: CONFIG.training.peekDelayMinMs,
      delayMax: CONFIG.training.peekDelayMaxMs,
      speedMult: 1.0,
      crouchWalkSpeed: CONFIG.training.crouchWalkSpeed, // 蹲走拉出移速：单一事实源在 CONFIG（菜单 applyAll 会覆盖，初始局也取同源值防漂移）
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
      shots: 0, hits: 0, headshots: 0, kills: 0,
      duelsLost: 0, // 漏杀：完整走完波次未被击杀的 Bot（161 轮起无对枪判负）,
      reactions: [], // ms
      lastReaction: 0,
      maxStreak: 0,   // 本局最长连杀（4.5s 窗口），main 在击杀时更新
      aimErrors: [],  // 预瞄误差（度）：Bot 露头瞬间准星与目标的角偏差 {yaw, pitch, mag}（带符号分量+幅值），Bot.step 采样
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
    // 池随英雄模板数建满（每只 Bot 构造时随机抽一名英雄 → 4 只覆盖全池）；满后
    // 从休眠 Bot 中随机挑一只复用 —— 出场英雄波次轮换，不整局锁死一名。尸体
    // （corpse 模式）不占 idle：休眠全无时回收最老尸体（尸体留存优先、池不膨胀）。
    // 单模板/程序化假人 cap=1，退化为「复用唯一一只」（原行为）
    const cap = Bot.customTemplates?.length || 1
    const idle = this.bots.filter(x => !x.active && x.mode !== 'dying' && x.mode !== 'corpse')
    const corpses = this.bots.filter(x => x.mode === 'corpse')
    let b = pickIdleBot(idle, corpses, this.bots.length, cap)
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

    // ctx 每步复用（128Hz × 每步一只字面量对象；player/alpha 每步覆盖写）
    const ctx = this._ctx ?? (this._ctx = { player: null, alpha: 1 })
    ctx.player = this.player
    ctx.alpha = alpha
    this._stepHold(dt)

    // 脚步声由 Bot.step 内置（与步频同步的空间音），这里不再重复触发
    for (const b of this.bots) {
      if (b.active || b.mode === 'dying') b.step(dt, ctx)
    }

  }

  // 渐进难度系数：每击杀延迟 ×0.93（下探到保底）、速度 ×1.02（封顶 1.3 倍）。
  // 越打越快逼出真实上限，也把"热身期"和"极限期"自然分开。
  get _rampKills() { return this.params.rampUp ? Math.min(this.stats.kills, 12) : 0 }
  get _rampDelay() { return Math.max(0.45, Math.pow(0.93, this._rampKills)) }
  get _rampSpeed() { return Math.min(1.3, this.params.speedMult * Math.pow(1.02, this._rampKills)) }

  // 架枪对枪调度：单缺口主槽常驻排程 + 双拉副槽（只在主槽双拉波同帧唤醒，平时休眠）
  _initHold() {
    return { slots: [
      { nextAt: 0, bot: null },
      { nextAt: Infinity, bot: null, partner: true },
    ] }
  }

  _stepHold(dt) {
    if (this.now() < this.countdownUntil) return // 倒计时内不出人
    const h = this.hold ??= this._initHold()
    for (const slot of h.slots) this._stepSlot(slot, dt)
  }

  _stepSlot(slot, dt) {
    const nowMs = this.now() * 1000
    const activeBot = slot.bot && slot.bot.active && slot.bot.mode === 'peek' ? slot.bot : null

    if (slot.nextAt === 0) { // 未排程 → 重新掷下一次出现时间
      if (slot.partner) { slot.nextAt = Infinity; return } // 副槽不自主排程：只随双拉波唤醒
      const dMin = Math.max(250, this.params.delayMin * this._rampDelay)
      const dMax = Math.max(dMin + 100, this.params.delayMax * this._rampDelay)
      // 三段式掷法（166 轮）：快速补拉（队友即刻跟上，还原对枪补位/双拉节奏）+
      // 短段（快连靶）+ 长段（留一段呼吸重置预瞄）——快慢交替比均匀分布更像真人
      // 推点；上限仍是 dMax，不会出现干等的长间隔。补拉段随 dMin 缩放（拖慢
      // 滑条时它也变慢，不越权推翻用户节奏）
      const mid = dMin + (dMax - dMin) * 0.45
      const bMin = Math.max(150, dMin * 0.45)
      const bMax = Math.max(bMin + 80, dMin * 0.7)
      const r = Math.random()
      slot.nextAt = nowMs + (r < 0.18 ? rand(bMin, bMax)
        : r < 0.75 ? rand(dMin, mid) : rand(mid, dMax))
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
      //  cross 贯穿跑过 —— 面向玩家横移贯穿缺口到另一侧（162 轮起不再顺跑向侧身）
      //  pull  拉出即缩 —— 面向玩家横移拉到折返点立即缩回
      slot.lastStyles ??= []
      const lastTwo = slot.lastStyles.slice(-2)
      const cross = lastTwo.length === 2 && lastTwo[0] === lastTwo[1]
        ? lastTwo[0] !== 'cross'
        : Math.random() < CONFIG.training.crossChance
      let startX
      if (cross) {
        startX = fromLeft ? gap.x0 - 2.2 : gap.x1 + 2.2
        const endX = fromLeft ? gap.x1 + 2.2 : gap.x0 - 2.2
        b.peek = { style: 'cross', startX, endX, dir: Math.sign(endX - startX) }
      } else {
        // 正面横向走出（pull）：从墙后藏点起步，面向玩家持枪横移拉出——胸口
        // 正对玩家（peekFacingYaw pull = 面向玩家），不停顿：拉到折返点即缩回
        const dir = fromLeft ? 1 : -1                       // 朝缺口内的拉出方向
        const edge = fromLeft ? gap.x0 : gap.x1             // 从这一侧的墙后拉出
        startX = edge - dir * rand(1.8, 2.4)                // 藏在墙后一点（留出加速距离）
        const turnX = (gap.x0 + gap.x1) / 2 - dir * rand(0, 0.9) // 折返点：窗口内、略偏拉出侧
        // 一部分拉出波是"露头即缩"jiggle-peek：拉到中段（已可见）立即折返，逼玩家守准星
        const jiggleAt = Math.random() < CONFIG.training.pullJiggleChance
          ? startX + dir * rand(0.5, 0.72) * Math.abs(turnX - startX)
          : 0
        b.peek = { style: 'pull', startX, turnX, endX: startX, dir, phase: 'out', jiggleAt,
          // 蹲走拉出掷定（非 jiggle 波）：有官方蹲走循环的模型才掷（与 Bot.js
          // 消费侧 this.anim?.crouchWalk 同口径）——程序化假人/无蹲走 clip 的
          // 老模型不进蹲走波（否则只表现为慢速站立横移，既不蹲也不贴几何）；
          // 命中区经骨锚跟随蹲姿
          crouchWalk: !jiggleAt && !!b.anim?.crouchWalk && Math.random() < CONFIG.training.crouchWalkChance }
      }
      b.place(startX, this.map.peekLineZ, 'peek')
      b.slot = slot
      slot.bot = b
      slot.nextAt = 0
      slot.lastStyles.push(b.peek.style)
      if (slot.lastStyles.length > 2) slot.lastStyles.shift() // 只留最近两条防连击判断
      // 双拉波（166 轮）：掷中则第二人同帧拉出——同侧同风格，整条线路沿行进
      // 方向后退一个身位 → 场上锁步跟随。还原本体双拉情景：一次缺口曝光两个
      // 目标，杀完第一个要立刻转火。副槽上一只还在场时本轮放弃双拉（不叠三人）
      const partner = this.hold?.slots[1]
      if (partner && !partner.bot?.active && Math.random() < CONFIG.training.doublePeekChance) {
        const b2 = this._bot()
        b2.peek = shiftPeek(b.peek, -b.peek.dir * CONFIG.training.doublePeekLane)
        b2.place(b2.peek.startX, this.map.peekLineZ, 'peek')
        b2.slot = partner
        partner.bot = b2
      }
      return
    }

    if (activeBot?.peek) {
      const pk = activeBot.peek
      const speed = CONFIG.bot.moveSpeed * this._rampSpeed
      // 波次收尾：完整走完未被击杀 = 漏杀（只进统计，无判负机制），躲进墙后
      // 才重新排程下一波（渐进难度系数在排程时生效）
      const finishWave = () => {
        // 漏杀可见性门槛：整波从未进过玩家视野（firstVisibleAt<0，玩家站远/
        // 走开）不计——与 reactions/aimErrors 的同款口径；口径变更点：旧局按
        // 无门槛计数，结算面板漏杀数值跨局不可直接对比
        if (activeBot.mode === 'peek' && activeBot.firstVisibleAt > 0) this.stats.duelsLost++
        activeBot.hide()
        slot.bot = null
        slot.nextAt = slot.partner ? Infinity : 0 // 副槽回休眠，主槽重掷下一波
      }
      if (pk.style === 'pull') {
        // 正面横移拉出（不停顿）：out（面向玩家横移拉出）→ leave（缩回原掩体）
        if (pk.phase === 'out') {
          // 蹲走拉出：蹲走速度档（官方蹲走循环），非全局跑速
          activeBot.moveToward(pk.dir * (pk.crouchWalk ? (this.params.crouchWalkSpeed ?? CROUCH_WALK_SPEED) : speed), dt)
          const target = pk.jiggleAt || pk.turnX
          const reached = pk.dir > 0 ? activeBot.pos.x >= target : activeBot.pos.x <= target
          if (reached) { pk.phase = 'leave'; pk.exitX = pk.startX } // 到折返点即缩（jiggle 只是折返更早）
        } else {
          const d = Math.sign(pk.exitX - activeBot.pos.x) || 1
          activeBot.moveToward(d * speed, dt)
          const done = d > 0 ? activeBot.pos.x >= pk.exitX : activeBot.pos.x <= pk.exitX
          if (done) finishWave()
        }
      } else {
        // cross：贯穿横移跑过（不停顿、不跳）
        activeBot.moveToward(pk.dir * speed, dt)
        if ((pk.dir > 0 && activeBot.pos.x >= pk.endX) || (pk.dir < 0 && activeBot.pos.x <= pk.endX)) finishWave()
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
      // 击杀即波次结束：从击杀时刻重掷下一波延迟（finishWave 同语义）。不重置
      // 的话 slot.nextAt 仍是"出场时刻+旧延迟"，中后段击杀的下一波会零延迟
      // 出场、绕过 delayMin 下限（节奏训练器的核心口径）。副槽回休眠（不自主排程）
      if (bot.slot) { bot.slot.bot = null; bot.slot.nextAt = bot.slot.partner ? Infinity : 0 }
      // 击杀时的爆头"叮"由 main 播（那里才知道连杀数 → 按连杀升调，与击杀
      // 确认音同一 pitch 阶梯）；未击杀命中的叮仍在下方（基础音高）
      this.onEvent?.('killed', { bot, zone })
      return true
    }
    this.audio.hitMark(zone === 'head')
    return false
  }

  // 地图重建（缺口左右切换）后：场上 Bot 的横移线还是旧缺口的，
  // 就地回收并重排下一波——不走完旧线（会从已封死的墙段里穿出来）。
  // 尸体也一并回收（躺在旧缺口坐标，新墙可能穿过它）
  onMapRebuilt() {
    for (const slot of this.hold?.slots ?? []) { slot.bot = null; slot.nextAt = slot.partner ? Infinity : 0 }
    for (const b of this.bots) {
      // dying（死亡动画中）也要回收：不回收会在动画结束时转成 corpse，永久
      // 躺在旧缺口的横移线上——新墙可能直接穿过尸体
      if ((b.active && b.mode === 'peek') || b.mode === 'dying' || b.mode === 'corpse') b.hide()
    }
  }

  // 敌方闪光起爆后由 main 调用："闪拉"配合——下一波 peek 提前到起爆后 ~0.5-1s
  // （本波已在场的让它演完，只影响未排程/晚排程的槽位）
  urgeNextPeek(afterSec = 0.8) {
    const h = this.hold
    if (!h || this.now() < this.countdownUntil) return
    const target = (this.now() + afterSec) * 1000
    for (const slot of h.slots) {
      if (slot.partner || slot.bot?.active) continue // 副槽不单飞：闪拉只催主槽下一波
      slot.nextAt = Math.min(slot.nextAt > 0 ? slot.nextAt : Infinity, target)
    }
  }

  registerShot() { this.stats.shots++ }
}
