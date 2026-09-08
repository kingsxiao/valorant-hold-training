import { describe, expect, it } from 'vitest'
import { peekFacingYaw, strafeRampW, strafeStepPose } from '../src/core/PeekPose.js'
import { BotManager, pickIdleBot } from '../src/entities/BotManager.js'

// 两种出场姿势（pull 横向拉出 / cross 侧身跑过）的朝向与步态判定。
// 场景坐标约定：玩家在 Bot 北侧（dz>0）——Bot 面向玩家 yaw=±π（模型正面 -Z，
// dx=0 时 atan2(-0,-dz) 走负零约定得 -π，与 +π 同方向，Bot.step 取最短角差）；
// cross 顺跑向 = ±π/2（velX>0 向右跑 -π/2）
const FACING = { velX: 5.4, moving: true, stopped: false }
const FACE_NORTH = -Math.PI

describe('peekFacingYaw 出场姿势朝向', () => {
  it('cross 移动中顺跑向：向右跑 -π/2、向左跑 +π/2（侧身入镜）', () => {
    expect(peekFacingYaw({ style: 'cross', canStrafe: true, ...FACING, velX: 5.4, dx: 0, dz: 30 })).toBeCloseTo(-Math.PI / 2)
    expect(peekFacingYaw({ style: 'cross', canStrafe: true, ...FACING, velX: -5.4, dx: 0, dz: 30 })).toBeCloseTo(Math.PI / 2)
  })

  it('pull 横移中面向玩家（strafe 对枪姿态，程序化/GLB 一致）：斜向也精确跟踪', () => {
    expect(peekFacingYaw({ style: 'pull', canStrafe: true, ...FACING, dx: 0, dz: 30 })).toBeCloseTo(FACE_NORTH)
    expect(peekFacingYaw({ style: 'pull', canStrafe: true, ...FACING, dx: 3, dz: 30 })).toBeCloseTo(Math.atan2(-3, -30))
  })

  it('pull 但骨骼链不齐的 GLB（canStrafe=false）→ 回退顺跑向（老模型防滑步）', () => {
    expect(peekFacingYaw({ style: 'pull', canStrafe: false, ...FACING, dx: 0, dz: 30 })).toBeCloseTo(-Math.PI / 2)
  })

  it('cross 急停（stopUntil 窗口内）转回面向玩家 = 停步挑战', () => {
    expect(peekFacingYaw({ style: 'cross', canStrafe: true, ...FACING, stopped: true, dx: 0, dz: 30 })).toBeCloseTo(FACE_NORTH)
  })

  it('站定/低速（moving=false）一律面向玩家', () => {
    expect(peekFacingYaw({ style: 'cross', canStrafe: true, velX: 0.2, moving: false, stopped: false, dx: 0, dz: 30 })).toBeCloseTo(FACE_NORTH)
    expect(peekFacingYaw({ style: 'pull', canStrafe: true, velX: 0, moving: false, stopped: false, dx: 0, dz: 30 })).toBeCloseTo(FACE_NORTH)
  })
})

describe('strafeRampW 横移步态权重（clip→程序化侧移淡入）', () => {
  it('cross 波恒 0（顺跑向前进 clip 原样）', () => {
    expect(strafeRampW({ style: 'cross', speed: 5.4 })).toBe(0)
  })

  it('pull 随移速 0.25→1.15 m/s 淡入：低速 0、中点 0.5、全速 1', () => {
    expect(strafeRampW({ style: 'pull', speed: 0.2 })).toBe(0)
    expect(strafeRampW({ style: 'pull', speed: 0.7 })).toBeCloseTo(0.5)
    expect(strafeRampW({ style: 'pull', speed: 1.15 })).toBe(1)
    expect(strafeRampW({ style: 'pull', speed: 5.4 })).toBe(1)
  })
})

describe('strafeStepPose 程序化侧移步态（与程序化假人同套 VALORANT 口径）', () => {
  it('镜像外展：abductL = −s·a、abductR = +s·a，步距开合随相位交替', () => {
    const ph0 = strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 1 })    // s=1：左腿 −a、右腿 +a
    const ph1 = strafeStepPose({ speed: 5.4, phase: Math.PI, lateralVel: 1 }) // s=−1：互换
    const a = Math.min(0.36, 0.12 + 5.4 * 0.058)
    expect(ph0.abductL).toBeCloseTo(-a)
    expect(ph0.abductR).toBeCloseTo(a)
    expect(ph1.abductL).toBeCloseTo(a)
    expect(ph1.abductR).toBeCloseTo(-a)
    expect(a).toBeCloseTo(0.36) // 全速外展封顶 0.36
  })

  it('外展幅度随移速增长并封顶：1 m/s ≈ 0.178、全速 0.36', () => {
    expect(strafeStepPose({ speed: 1, phase: 0, lateralVel: 1 }).abductR).toBeCloseTo(0.12 + 0.058)
  })

  it('脚尖微朝移动方向（含步内反摆）：feetYaw = −sign(lx)·0.26 + s·0.12', () => {
    expect(strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 1 }).feetYaw).toBeCloseTo(-0.26 + 0.12)
    expect(strafeStepPose({ speed: 5.4, phase: 0, lateralVel: -1 }).feetYaw).toBeCloseTo(0.26 + 0.12)
    expect(strafeStepPose({ speed: 5.4, phase: Math.PI / 2, lateralVel: 1 }).feetYaw).toBeCloseTo(-0.26) // s=0
  })

  it('屈膝：支撑步（|s|=1）近伸直 0.06，并腿过中点（s=0）最深、随速度加强', () => {
    const support = strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 1 })
    const passing = strafeStepPose({ speed: 5.4, phase: Math.PI / 2, lateralVel: 1 })
    expect(support.knee).toBeCloseTo(0.06)
    expect(passing.knee).toBeCloseTo(0.06 + 0.4) // 全速过中点
    expect(strafeStepPose({ speed: 1.35, phase: Math.PI / 2, lateralVel: 1 }).knee).toBeCloseTo(0.06 + 0.4 * (1.35 / 5.4))
  })

  it('重心起伏：落脚最低（|s|=1 → 0）、并腿过中点最高（0.01+speed·0.0036）', () => {
    expect(strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 1 }).bob).toBeCloseTo(0)
    expect(strafeStepPose({ speed: 5.4, phase: Math.PI / 2, lateralVel: 1 }).bob).toBeCloseTo(0.01 + 5.4 * 0.0036)
  })

  it('侧倾向移动方向且 ±0.05 限幅（与程序化假人 _stepLegs 同参数）', () => {
    expect(strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 5.4 }).lean).toBeCloseTo(-0.05)
    expect(strafeStepPose({ speed: 5.4, phase: 0, lateralVel: -5.4 }).lean).toBeCloseTo(0.05)
    expect(strafeStepPose({ speed: 1.5, phase: 0, lateralVel: 1.5 }).lean).toBeCloseTo(-1.5 * 0.011)
  })
})

// —— BotManager 风格抽签：50/50 随机 + 连出两波同风格强制换（两种姿势交替）——
const GAP = { x0: -9, x1: -6 }

function spawnWith(lastStyles, randVal) {
  // 每次一个全新到期槽位（nextAt:-1）——出人后 nextAt 复位为 0 走排程分支，
  // 复用同一 slot 第二次调用的不是"到期出人"，只透传 lastStyles 历史
  const slot = { nextAt: -1, bot: null, lastStyles: [...(lastStyles ?? [])] }
  const bot = { peek: null, place() { } }
  const mgr = {
    now: () => 0,
    params: { peekSide: 'left' },
    map: { gaps: [GAP], peekLineZ: -23 },
    _bot: () => bot,
  }
  const orig = Math.random
  Math.random = () => randVal
  try {
    BotManager.prototype._stepSlot.call(mgr, slot, 1 / 128)
  } finally {
    Math.random = orig
  }
  return { bot, slot }
}

describe('出场风格防连击（两种姿势交替）', () => {
  it('无连击时仍按 crossChance 随机（既有口径不变）', () => {
    expect(spawnWith(null, 0).bot.peek.style).toBe('cross')
    expect(spawnWith(null, 0.99).bot.peek.style).toBe('pull')
  })

  it('连出两波 cross 后强制 pull（随机数再小也不出第三波 cross）', () => {
    expect(spawnWith(['cross', 'cross'], 0).bot.peek.style).toBe('pull')
  })

  it('连出两波 pull 后强制 cross（随机数再大也不出第三波 pull）', () => {
    expect(spawnWith(['pull', 'pull'], 0.99).bot.peek.style).toBe('cross')
  })

  it('无连击的历史不干预抽签（cross,pull 后仍按随机数走）', () => {
    expect(spawnWith(['cross', 'pull'], 0).bot.peek.style).toBe('cross')
    expect(spawnWith(['cross', 'pull'], 0.99).bot.peek.style).toBe('pull')
  })

  it('出场后记入历史且只留最近两条（不无限增长）', () => {
    const { slot } = spawnWith(['cross', 'pull'], 0) // 无连击 → cross
    expect(slot.lastStyles).toEqual(['pull', 'cross'])
  })
})

// —— 池调度：英雄池下波次轮换出场英雄（不整局锁死一名），单模板退化为原行为 ——
describe('pickIdleBot 池调度（英雄池轮换）', () => {
  const bots = (n) => Array.from({ length: n }, (_, i) => ({ i, active: false, mode: 'idle' }))

  it('池未满 → null（新建：每只构造时随机抽英雄，4 只覆盖全英雄池）', () => {
    expect(pickIdleBot(bots(1), 1, 4)).toBeNull()
    expect(pickIdleBot(bots(3), 3, 4)).toBeNull()
  })

  it('池满 → 从休眠 Bot 随机挑一只（边界随机数取首/末/中间）', () => {
    const idle = bots(4)
    expect(pickIdleBot(idle, 4, 4, () => 0)).toBe(idle[0])
    expect(pickIdleBot(idle, 4, 4, () => 0.5)).toBe(idle[2])
    expect(pickIdleBot(idle, 4, 4, () => 0.999)).toBe(idle[3])
  })

  it('单模板（cap=1，程序化假人/agent.glb）→ 唯一一只 = 原「复用第一只」行为', () => {
    const only = bots(1)
    expect(pickIdleBot(only, 1, 1, () => 0.999)).toBe(only[0])
  })

  it('池满但全在忙（活跃/濒死）→ undefined→ falsy → 调用侧新建（与原 find 落空同路）', () => {
    expect(pickIdleBot([], 4, 4)).toBeFalsy()
  })
})
