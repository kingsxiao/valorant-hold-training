import { describe, expect, it } from 'vitest'
import { peekFacingYaw, strafeGait } from '../src/core/PeekPose.js'
import { BotManager } from '../src/entities/BotManager.js'

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

describe('strafeGait GLB 横移步态骨骼偏转', () => {
  it('cross 波不偏转（顺跑向前进跑姿，clip 原样）', () => {
    expect(strafeGait({ style: 'cross', speed: 5.4, lateralVel: 5.4 })).toEqual({ w: 0, hipYaw: 0, lean: 0 })
  })

  it('pull 静止/起步低速（<0.25 m/s）不偏转', () => {
    expect(strafeGait({ style: 'pull', speed: 0.2, lateralVel: 0.2 }).w).toBe(0)
    expect(strafeGait({ style: 'pull', speed: 0, lateralVel: 0 }).hipYaw).toBe(0)
  })

  it('pull 全速横移：w=1、髋部 ±π/2 朝移动方向（前进 clip 迈步转向移动方向，不滑步）', () => {
    expect(strafeGait({ style: 'pull', speed: 5.4, lateralVel: 5.4 }).hipYaw).toBeCloseTo(-Math.PI / 2) // 向模型右侧
    expect(strafeGait({ style: 'pull', speed: 5.4, lateralVel: -5.4 }).hipYaw).toBeCloseTo(Math.PI / 2) // 向模型左侧
  })

  it('偏转随移速淡入（与 idle→walk 权重同曲线）：0.7 m/s 中点 → w=0.5、±π/4', () => {
    const g = strafeGait({ style: 'pull', speed: 0.7, lateralVel: 0.7 })
    expect(g.w).toBeCloseTo(0.5)
    expect(g.hipYaw).toBeCloseTo(-Math.PI / 4)
    expect(strafeGait({ style: 'pull', speed: 1.15, lateralVel: -1.15 }).w).toBeCloseTo(1)
  })

  it('侧倾向移动方向且 ±0.05 限幅（与程序化假人 _stepLegs 同参数）', () => {
    expect(strafeGait({ style: 'pull', speed: 5.4, lateralVel: 5.4 }).lean).toBeCloseTo(-0.05) // 5.4×0.011 超限幅
    expect(strafeGait({ style: 'pull', speed: 5.4, lateralVel: -5.4 }).lean).toBeCloseTo(0.05)
    expect(strafeGait({ style: 'pull', speed: 1.5, lateralVel: 1.5 }).lean).toBeCloseTo(-1.5 * 0.011)
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
