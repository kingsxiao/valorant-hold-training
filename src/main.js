import * as THREE from 'three'
import { CONFIG } from './core/Config.js'
import { Engine } from './core/Engine.js'
import { Input } from './core/Input.js'
import { AudioSys } from './core/Audio.js'
import { World } from './world/World.js'
import { MapBuilder } from './world/MapBuilder.js'
import { FX } from './world/FX.js'
import { Player } from './player/Player.js'
import { WeaponSystem } from './weapons/WeaponSystem.js'
import { BotManager, MODE_INFO } from './entities/BotManager.js'
import { Crosshair } from './ui/Crosshair.js'
import { HUD } from './ui/HUD.js'
import { Menu, loadBests, saveBest } from './ui/Menu.js'
import { ResultPanel } from './ui/ResultPanel.js'
import { loadUserAssets } from './core/UserAssets.js'
import { Bot } from './entities/Bot.js'

// ============================================================================
// 组装：Engine(渲染/循环) + Input + Audio + World/Map + Player + Weapons + Bots + UI
// 状态机：menu(暂停) ⇄ playing；回合结束 → 结算
// ============================================================================
const canvas = document.getElementById('game')
const hudRoot = document.getElementById('hud')
const overlay = document.getElementById('overlay')

const engine = new Engine(canvas)
const input = new Input(canvas)
const audio = new AudioSys()
const world = new World()
const map = new MapBuilder(world, engine.scene)
const fx = new FX(engine.scene, engine.camera)
const player = new Player(world, audio)
const bots = new BotManager({ scene: engine.scene, world, map, audio, player })
const hud = new HUD(hudRoot)
const crosshair = new Crosshair(hudRoot)
const menu = new Menu({ overlay, onReady: startRound })
// 回合结算：独立面板，与设置面板互斥显示
const result = new ResultPanel({
  overlay,
  onRestart: () => startRound(state.cfg),
  onSettings: () => { result.hide(); menu.show() },
})

// ---- 状态 ----
const state = {
  playing: false,
  cfg: menu.cfg, // 共享配置对象（菜单实时改）
  score: 0,      // 本局得分：击杀 100 + 爆头 50 + 连杀 ×25
  bestAtStart: 0 // 本局开始时的个人最佳（用于破纪录判断）
}

// ---- 武器系统 ----
const weapons = new WeaponSystem({
  camera: engine.camera, vmCamera: engine.vmCamera, world, bots, fx, audio, player,
})
weapons.onShotFired = () => bots.registerShot()

// 击杀反馈主链路：命中标记 / 伤害数字 / 粒子爆发 / 击杀横幅 / 击杀信息流 / 得分
// （命中"叮"声在 BotManager.damage 内；击杀确认音在这里播 —— 只有这里知道连杀数）
weapons.onHitBot = (bot, zone, dmg, killed, point) => {
  const head = zone === 'head'
  hud.showHitmarker(head, killed)
  if (point) {
    hud.spawnDamage(point.x, point.y + 0.15, point.z, dmg, head, engine.camera, killed)
    if (killed) fx.killBurst(point, head)
    else fx.hitBurst(point, head)
  }
  if (killed) {
    const r = bots.stats.lastReaction
    const nowS = bots.now() // 游戏时钟：连杀窗口不受暂停影响
    killTimes.push(nowS)
    if (killTimes.length > 32) killTimes.shift()
    let streak = 1
    for (let i = killTimes.length - 2; i >= 0 && nowS - killTimes[i] <= 4.5; i--) streak++
    // 击杀确认音：爆头保持"先叮后确认"层次；连杀每级升半音（上限 +4）
    audio.kill(head ? 0.06 : 0, Math.pow(2, Math.min(streak - 1, 4) / 12))
    hud.showKill({ streak, reaction: r, head })
    hud.addKillFeed(`BOT-${String(bot.id % 100).padStart(2, '0')}`, head, r)
    state.score += 100 + (head ? 50 : 0) + (streak - 1) * 25
    hud.setScore(state.score, state.bestAtStart, state.score > state.bestAtStart)
    hud.popScore()
  }
}
weapons.onAmmoChange = () => hud.setAmmo(weapons.weapon)
// 枪口焰精灵/点光由 FX.muzzle 按 viewmodel 实测枪口世界坐标点亮（不再挂相机固定偏移）

// 对枪失败时 Bot 的开火视觉表现：枪口焰 + 曳光射向玩家 + 轻微视角冲击
// （敌方枪声在 BotManager._loseDuel 内从 Bot 位置空间化播放）
bots.onBotFire = (bot) => {
  const dx = player.pos.x - bot.pos.x, dz = player.pos.z - bot.pos.z
  const d = Math.max(0.001, Math.hypot(dx, dz))
  const from = { x: bot.pos.x + dx / d * 0.55, y: 1.31, z: bot.pos.z + dz / d * 0.55 }
  fx.muzzle(from)
  fx.tracer(new THREE.Vector3(from.x, from.y, from.z), engine.camera.position)
  player.addPunch(0.02, (Math.random() - 0.5) * 0.01)
}

bots.onEvent = (type, data) => {
  if (type === 'lost-duel') {
    hud.hurtFlash()
    hud.toastMsg(`对枪失败 —— 慢了（${data.bot.gapName ?? '?'} 缺口）`, 1400)
    // 受击方向指示：弧形红圈指向来源 Bot
    const b = data.bot
    if (b) {
      const dx = b.pos.x - player.pos.x, dz = b.pos.z - player.pos.z
      const fx_ = -Math.sin(player.yaw), fz_ = -Math.cos(player.yaw) // 玩家前向
      const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw)    // 玩家右向
      hud.showDamageDir(Math.atan2(dx * rx + dz * rz, dx * fx_ + dz * fz_))
    }
  } else if (type === 'round-end') {
    state.playing = false
    document.exitPointerLock?.()
    menu.hide()
    // 个人最佳落盘：破纪录时结算面板绿色高亮
    const prev = loadBests().hold ?? 0
    const newBest = state.score > prev && state.score > 0
    if (newBest) saveBest('hold', state.score)
    result.show({ ...data, score: state.score, best: Math.max(prev, state.score), newBest })
  }
}

// ---- 键位：切枪 ----
input.onKey = (code) => {
  if (!state.playing) return
  if (code === 'Digit1') weapons.switchTo(state.cfg.primary)
  if (code === 'Digit2') weapons.switchTo(state.cfg.secondary)
  if (code === 'Digit3') weapons.switchTo('knife')
}

// 连杀统计窗口（4.5s）——回合开始时清空，避免跨局串杀
const killTimes = []

// ---- 指针锁定 ⇄ 暂停 ----
input.onLockChange = (locked) => {
  if (locked) {
    menu.hide()
    state.playing = true
  } else if (state.playing) {
    state.playing = false
    menu.show()
  }
}

// ---- 菜单实时应用设置 ----
menu.applyAll = () => {
  const cfg = state.cfg
  crosshair.apply(cfg.crosshair)
  audio.setVolume(cfg.volume)
  // 两个滑条独立可拉交叉，交叉时按 [min,max] 归位（rand(a,b) 对 a>b 是反区间）
  bots.params.delayMin = Math.min(cfg.delayMin, cfg.delayMax)
  bots.params.delayMax = Math.max(cfg.delayMin, cfg.delayMax)
  bots.params.speedMult = cfg.speedMult
  bots.params.aimTimeMs = cfg.aimTimeMs
  bots.params.roundSeconds = cfg.roundSeconds
  engine.autoRes = cfg.autoRes !== false
  engine.setResolutionScale(cfg.resScale ?? 1)
  engine.setShadows(!!cfg.shadows)
  hud.fpsBox.style.display = cfg.showFps === false ? 'none' : ''
}
menu.applyAll()

// ---- 开局 ----
function startRound(cfg) {
  Object.assign(state.cfg, cfg)
  menu.applyAll()
  audio.ensure()
  audio.setVolume(cfg.volume)
  killTimes.length = 0

  // 出生点：架枪位正后，面向两个缺口
  player.respawn(map.spawn.x, map.spawn.z, map.spawn.yaw)
  player.hp = 100

  weapons.primaryId = cfg.primary
  weapons.secondaryId = cfg.secondary
  weapons.switchTo(cfg.primary, true)

  // 计分：清零并载入个人最佳（倒计时期间 HUD 即显示）
  state.score = 0
  state.bestAtStart = loadBests().hold ?? 0
  hud.setScore(0, state.bestAtStart, false)
  countLast = null
  goShowUntil = 0

  bots.resetRound()
  hud.setAmmo(weapons.weapon)
  hud.setMode(MODE_INFO.label, MODE_INFO.desc)

  menu.hide()
  result.hide()
  input.lock() // unadjustedMovement 原始输入优先，失败自动回退（内部静默）
  state.playing = true
}

// ---- 主循环 ----
// 每渲染帧最先消费鼠标增量：视角直通（零延迟），边沿喂给逻辑步
let frameMouse = { dx: 0, dy: 0 }
engine.preFrame = () => {
  const m = input.consumeMouse()
  player.applyMouse(m.dx, m.dy, state.cfg.sens)
  weapons.queueEdges(m.e0, m.e1)
  frameMouse.dx = m.dx
  frameMouse.dy = m.dy
}

engine.simStep = (dt) => {
  if (!state.playing) return
  player.step(dt, input, weapons.weapon)
  if (player.alive) weapons.step(dt, input)
  bots.step(dt, 1)

  // 玩家死亡（对枪失败）→ 1.2s 后原地复活继续训练（逻辑帧计时，暂停时冻结）
  if (!player.alive && player.deadT > 1.2) {
    player.respawn(player.pos.x, player.pos.z, player.yaw)
  }
}

const _hudAccum = { stats: 0, fpsText: 0 }
// 倒计时显示状态（渲染帧维护；tick 音在秒变化沿触发）
let countLast = null
let goShowUntil = 0

engine.renderFrame = (alpha, dtMs) => {
  const dt = dtMs / 1000
  player.updateCamera(engine.camera, alpha)
  weapons.updateViewmodel(dt, frameMouse.dx, frameMouse.dy)
  fx.calibrate(innerWidth, innerHeight, engine.camera.fov) // 粒子点大小随窗口/FOV 校准
  fx.update(dt)
  hud.updateDamage(dt)

  // 动态准星：当前散布（度）→ 屏幕像素，实时可视化误差
  crosshair.setSpread(
    state.playing && weapons.weapon.slot !== 'melee' ? weapons.currentSpread() : 0,
    engine.camera.fov, innerHeight,
  )

  // 开局倒计时：3 · 2 · 1 · GO（Bot 在 GO 前不出人，回合计时从 GO 起算）
  if (state.playing && bots.running) {
    const nowS = bots.now()
    const remain = bots.countdownUntil - nowS
    if (remain > 0) {
      const n = Math.ceil(remain)
      if (n !== countLast) { countLast = n; audio.countTick(false) }
      hud.setCenter(`<div class="big">${n}</div><div style="opacity:.55;font-size:12px;letter-spacing:4px;margin-top:4px">GET READY</div>`)
    } else if (countLast !== null || goShowUntil > nowS) {
      if (countLast !== null) { audio.countTick(true); goShowUntil = nowS + 0.55 }
      countLast = null
      hud.setCenter(`<div class="big" style="color:#7dff9a;text-shadow:0 2px 18px rgba(125,255,154,.4),0 2px 10px rgba(0,0,0,.7)">GO!</div>`)
      if (nowS > goShowUntil) hud.setCenter('')
    }
  } else if (!state.playing) {
    hud.setCenter('')
  }

  // HUD（节流写入，避免每帧 DOM 重排）
  hud.setSpeed(player.moveSpeed)
  hud.setHP(player.hp)
  hud.setMode(MODE_INFO.label,
    bots.params.roundSeconds > 0 && bots.running && bots.roundEndAt > 0
      ? `${Math.max(0, bots.roundEndAt - bots.now()).toFixed(1)}s` // 游戏时钟：暂停时倒计时冻结
      : MODE_INFO.desc)
  _hudAccum.stats += dtMs
  if (_hudAccum.stats > 200) { _hudAccum.stats = 0; hud.setStats(bots.stats, engine) }
  hud.pushFps(dtMs)
  _hudAccum.fpsText += dtMs
  if (_hudAccum.fpsText > 500) {
    _hudAccum.fpsText = 0
    hud.setFpsText(`${engine.fps} fps` + (engine.autoScale < 1 ? ` · ${Math.round(engine.autoScale * 100)}%` : ''))
  }
}

engine.start()

// WebGL 上下文丢失/恢复：暂停并提示（Engine 内部已停/重启渲染循环）
engine.onContextLost = () => {
  state.playing = false
  document.exitPointerLock?.()
  menu.show()
  hud.toastMsg('图形上下文已断开，恢复后请重新开始', 3000)
}

// 调试句柄（自动化测试 / 控制台调参用）—— 仅开发构建暴露
if (import.meta.env.DEV) {
  window.__game = { engine, input, audio, world, map, player, weapons, bots, hud, menu, result, state, CONFIG }
}

// 用户/开源资产（可选）：public/models/ 下的 agent.glb、viewmodel-vandal/phantom.glb
// （双枪各有高模；旧 viewmodel.glb 单模型作回退）、glove.glb 与 hands.glb
loadUserAssets().then(({ agent, agentAnimations, viewmodel, viewmodels, glove, hands }) => {
  let changed = false
  if (agent) { Bot.customTemplate = agent; Bot.customAnimations = agentAnimations; changed = true }
  const vmMap = {}
  for (const id of ['vandal', 'phantom']) if (viewmodels?.[id]) vmMap[id] = viewmodels[id]
  if (!Object.keys(vmMap).length && viewmodel) vmMap.vandal = vmMap.phantom = viewmodel // 旧单模型
  if (Object.keys(vmMap).length) { weapons.setCustomViewmodel(vmMap); changed = true }
  // 手部方案（2026-09-03 定稿）：glove.glb 五指手套双手实例为主路径——五指独立
  // 骨骼可逐指贴合真实握枪姿势（合并指的 hands.glb 做不到逐指）；建模袖臂仍取
  // hands.glb（placeArmsIK 两骨 IK + 解剖学定尺精确衔接手套腕口）。
  // hands.glb 整臂（四指合并）保留为后备（glove 缺失/骨架不符时回退）。
  if (glove && weapons.setGloveHands(glove, hands) !== false) changed = true
  else if (hands && weapons.setCustomHands(hands) !== false) changed = true
  if (changed) bots.resetRound() // 场上的 Bot 换新外观
}).catch(e => console.error('[VHT] asset load failed', e))

// 首屏菜单（弹药无限：HUD 显示 ∞）
hud.setAmmo(CONFIG.weapons.vandal)
menu.show()

// 模块初始化完成：载入页淡出（纹理生成在此同步阶段完成，之前 splash 一直可见）
const splash = document.getElementById('splash')
if (splash) {
  splash.classList.add('done')
  setTimeout(() => splash.remove(), 400)
}
