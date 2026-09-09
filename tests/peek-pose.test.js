import { describe, expect, it } from 'vitest'
import { peekFacingYaw, strafeRampW, strafeStepPose, leanInto } from '../src/core/PeekPose.js'
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

describe('strafeStepPose 程序化侧移步态（官方横移循环口径）', () => {
  it('官方 RunE 结构：腿链朝移动方向 yaw≈0.90，左右腿反相深膝循环（一屈一伸）', () => {
    const p0 = strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 1 })
    expect(p0.yaw).toBeCloseTo(-0.90 + 0.12)                       // 向右移腿链朝右
    expect(strafeStepPose({ speed: 5.4, phase: 0, lateralVel: -1 }).yaw).toBeCloseTo(0.90 + 0.12)
    expect(p0.thighR).toBeCloseTo(-p0.thighL)                      // 反相：一前一后
    const half = strafeStepPose({ speed: 5.4, phase: Math.PI, lateralVel: 1 })
    expect(p0.kneeR).toBeCloseTo(half.kneeL)                       // R 腿取 p+π 相位
  })

  it('膝曲线官方 WalkE→RunE 双锚点按速度插值：5.4=RunE 既有口径、走速以下全程 WalkE 深膝', () => {
    const p = strafeStepPose({ speed: 5.4, phase: 2.0, lateralVel: 1 })
    expect(p.thighL).toBeCloseTo(0.82 * Math.sin(2.0))             // 官方髋摆 0.82rad（RunE 锚点）
    expect(p.kneeL).toBeCloseTo(0.20 + 1.55 * Math.max(0, -Math.sin(2.0 - 0.5))) // 官方 RunE 膝曲线
    // 走速（3.39）及以下 = WalkE 锚点（基础 28.1°/摆动幅 60.6°）：起步拉出是深膝慢步，不再浅膝缩放
    const slow = strafeStepPose({ speed: 1.35, phase: 2.0, lateralVel: 1 })
    expect(slow.thighL).toBeCloseTo(0.70 * Math.sin(2.0))
    expect(slow.kneeL).toBeCloseTo(0.49 + 1.06 * Math.max(0, -Math.sin(2.0 - 0.5)))
    const atWalk = strafeStepPose({ speed: 3.39, phase: 2.0, lateralVel: 1 })
    expect(atWalk.kneeL).toBeCloseTo(slow.kneeL)                   // 3.39 以下不再随速度缩幅
    // 中点线性插值（(1.35+5.4)/2 不落在锚点上，取 4.395 = t 0.5）
    const mid = strafeStepPose({ speed: 4.395, phase: 2.0, lateralVel: 1 })
    expect(mid.kneeL).toBeCloseTo((p.kneeL + slow.kneeL) / 2)
    expect(mid.thighL).toBeCloseTo((p.thighL + slow.thighL) / 2)
  })

  it('小幅外展稳定（±0.12·k·s，官方 RunE 髋 Y 分量 ~35% 的量级）', () => {
    const p0 = strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 1 })   // s=1
    expect(p0.abductL).toBeCloseTo(-0.12)
    expect(p0.abductR).toBeCloseTo(0.12)
    const ph = strafeStepPose({ speed: 5.4, phase: Math.PI / 2, lateralVel: 1 }) // s=0
    expect(ph.abductL).toBeCloseTo(0)
    expect(ph.abductR).toBeCloseTo(0)
  })

  it('重心起伏：落脚最低（|s|=1 → 0）、过中点最高（0.01+speed·0.0036）', () => {
    expect(strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 1 }).bob).toBeCloseTo(0)
    expect(strafeStepPose({ speed: 5.4, phase: Math.PI / 2, lateralVel: 1 }).bob).toBeCloseTo(0.01 + 5.4 * 0.0036)
  })

  it('侧倾向移动方向且 ±0.12 限幅（官方 RunE/W 盆骨侧倾 5~10° 口径）', () => {
    expect(strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 5.4 }).lean).toBeCloseTo(-0.108)
    expect(strafeStepPose({ speed: 5.4, phase: 0, lateralVel: -5.4 }).lean).toBeCloseTo(0.108)
    expect(strafeStepPose({ speed: 1.5, phase: 0, lateralVel: 1.5 }).lean).toBeCloseTo(-1.5 * 0.02)
    expect(leanInto(99)).toBeCloseTo(-0.12)
    expect(leanInto(-99)).toBeCloseTo(0.12)
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

// —— 池调度：英雄池下波次轮换出场英雄（不整局锁死一名），单模板退化为原行为；
// —— 尸体留存（corpse 模式）下：休眠全无 → 回收最老尸体，池大小保持稳定 ——
describe('pickIdleBot 池调度（英雄池轮换）', () => {
  const bots = (n) => Array.from({ length: n }, (_, i) => ({ i, active: false, mode: 'idle' }))

  it('池未满 → null（新建：每只构造时随机抽英雄，4 只覆盖全英雄池）', () => {
    expect(pickIdleBot(bots(1), [], 1, 4)).toBeNull()
    expect(pickIdleBot(bots(3), [], 3, 4)).toBeNull()
  })

  it('池满 → 从休眠 Bot 随挑一只（边界随机数取首/末/中间）', () => {
    const idle = bots(4)
    expect(pickIdleBot(idle, [], 4, 4, () => 0)).toBe(idle[0])
    expect(pickIdleBot(idle, [], 4, 4, () => 0.5)).toBe(idle[2])
    expect(pickIdleBot(idle, [], 4, 4, () => 0.999)).toBe(idle[3])
  })

  it('单模板（cap=1，程序化假人/agent.glb）→ 唯一一只 = 原「复用第一只」行为', () => {
    const only = bots(1)
    expect(pickIdleBot(only, [], 1, 1, () => 0.999)).toBe(only[0])
  })

  it('池满但全在忙（活跃/濒死/尸体皆无）→ falsy → 调用侧新建（与原 find 落空同路）', () => {
    expect(pickIdleBot([], [], 4, 4)).toBeFalsy()
  })

  it('休眠全无但有尸体 → 回收最老的一具（corpseAt 最小）；休眠非空不受尸体影响', () => {
    const corpses = [
      { i: 0, mode: 'corpse', corpseAt: 30 },
      { i: 1, mode: 'corpse', corpseAt: 12 },
      { i: 2, mode: 'corpse', corpseAt: 25 },
    ]
    expect(pickIdleBot([], corpses, 4, 4)).toBe(corpses[1])
    const idle = [{ i: 9, active: false, mode: 'idle' }]
    expect(pickIdleBot(idle, corpses, 4, 4, () => 0.9)).toBe(idle[0]) // 尸体不抢休眠的轮换
  })
})
