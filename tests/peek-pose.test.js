import { describe, expect, it } from 'vitest'
import { peekFacingYaw, strafeRampW, strafeStepPose, leanInto } from '../src/core/PeekPose.js'
import { BotManager, pickIdleBot } from '../src/entities/BotManager.js'
import { GAP_LEFT as GAP, SPAWN_Z } from '../src/world/corridor.js' // 训练不变量单一事实源

// 两种出场姿势（pull 拉出即缩 / cross 贯穿跑过）的朝向与步态判定——162 轮起
// 两者都全程面朝玩家横移（cross 曾顺跑向 = 玩家全程看侧身）。
// 模型正面朝向（164 轮实测定案）：英雄 GLB 视觉正面 = 局部 +Z（默认
// front=+1：kamae 持枪位 L_Hand 前伸 z=+0.49 ⇒ 前方=+Z）；程序化假人正面
// -Z（front=-1）。玩家在 Bot 北侧（dz>0）时 GLB 面向玩家 yaw=0
const FACING = { velX: 5.4, moving: true, stopped: false }
const FACE_NORTH = 0

describe('peekFacingYaw 出场姿势朝向', () => {
  it('cross/pull 移动中都面向玩家（正面横移）：斜向也精确跟踪', () => {
    expect(peekFacingYaw({ style: 'cross', canStrafe: true, ...FACING, dx: 0, dz: 30 })).toBeCloseTo(FACE_NORTH)
    expect(peekFacingYaw({ style: 'cross', canStrafe: true, ...FACING, dx: 3, dz: 30 })).toBeCloseTo(Math.atan2(3, 30))
    expect(peekFacingYaw({ style: 'pull', canStrafe: true, ...FACING, dx: 0, dz: 30 })).toBeCloseTo(FACE_NORTH)
    expect(peekFacingYaw({ style: 'pull', canStrafe: true, ...FACING, dx: 3, dz: 30 })).toBeCloseTo(Math.atan2(3, 30))
  })

  it('腿骨链不齐的老模型（canStrafe=false，无横移步态）→ 回退顺跑向（防滑步）', () => {
    expect(peekFacingYaw({ style: 'pull', canStrafe: false, ...FACING, dx: 0, dz: 30 })).toBeCloseTo(Math.PI / 2)
    expect(peekFacingYaw({ style: 'cross', canStrafe: false, ...FACING, velX: -5.4, dx: 0, dz: 30 })).toBeCloseTo(-Math.PI / 2)
  })

  it('程序化假人（front=-1，面罩画在 -Z）保持旧 -Z 约定不被 GLB 翻转波及', () => {
    expect(peekFacingYaw({ style: 'pull', canStrafe: true, ...FACING, front: -1, dx: 0, dz: 30 })).toBeCloseTo(Math.atan2(-0, -30))
    expect(peekFacingYaw({ style: 'pull', canStrafe: true, ...FACING, front: -1, dx: 3, dz: 30 })).toBeCloseTo(Math.atan2(-3, -30))
    expect(peekFacingYaw({ style: 'pull', canStrafe: false, ...FACING, front: -1, dx: 0, dz: 30 })).toBeCloseTo(-Math.PI / 2)
    expect(peekFacingYaw({ style: 'pull', canStrafe: false, ...FACING, velX: -5.4, front: -1, dx: 0, dz: 30 })).toBeCloseTo(Math.PI / 2)
  })

  it('站定/急停（stopped）一律面向玩家', () => {
    expect(peekFacingYaw({ style: 'cross', canStrafe: true, ...FACING, stopped: true, dx: 0, dz: 30 })).toBeCloseTo(FACE_NORTH)
    expect(peekFacingYaw({ style: 'cross', canStrafe: true, velX: 0.2, moving: false, stopped: false, dx: 0, dz: 30 })).toBeCloseTo(FACE_NORTH)
    expect(peekFacingYaw({ style: 'pull', canStrafe: true, velX: 0, moving: false, stopped: false, dx: 0, dz: 30 })).toBeCloseTo(FACE_NORTH)
  })
})

describe('strafeRampW 横移步态权重（clip→程序化侧移淡入）', () => {
  it('pull 与 cross（贯穿也面向玩家横移，162 轮）同随移速 0.25→1.15 淡入', () => {
    for (const style of ['pull', 'cross']) {
      expect(strafeRampW({ style, speed: 0.2 })).toBe(0)
      expect(strafeRampW({ style, speed: 0.7 })).toBeCloseTo(0.5)
      expect(strafeRampW({ style, speed: 1.15 })).toBe(1)
      expect(strafeRampW({ style, speed: 5.4 })).toBe(1)
    }
  })
})

describe('strafeStepPose 程序化侧移步态（官方横移循环口径）', () => {
  it('out 参数：传 scratch 时返回同一对象、字段全量写入（128Hz 热路径零分配契约）；数值与缺省路径一致', () => {
    const out = {}
    const r = strafeStepPose({ speed: 5.4, phase: 1, lateralVel: 5.4 }, out)
    expect(r).toBe(out)
    expect(Object.keys(r).sort()).toEqual(
      ['abductL', 'abductR', 'bob', 'kneeL', 'kneeR', 'lean', 's', 'thighL', 'thighR', 'yawL', 'yawR'])
    const plain = strafeStepPose({ speed: 5.4, phase: 1, lateralVel: 5.4 })
    for (const k of Object.keys(r)) expect(r[k], k).toBeCloseTo(plain[k], 12)
  })
  it('官方 RunE/W 方向性剪：thigh 幅 0.548±0.109 随向、偏置 ∓0.56（TP_Core 实测幅/偏置），yaw 脚尖朝向保留', () => {
    // 右移（W 族）：L 大腿偏置 +0.56（官方 RunW L ∈ [+5.5°,+55.8°] → +0.535）
    const pw = strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 1 })
    expect(pw.thighL).toBeCloseTo((0.548 - 0.109) * Math.sin(0) + 0.56)
    expect(pw.thighL).toBeGreaterThan(0.3)                          // L 前跨（沿运动方向）
    expect(pw.thighR).toBeCloseTo(-(0.548 - 0.109) * Math.sin(0) - 0.56) // R 反相镜像
    // 左移（E 族）：L 大腿偏置 −0.56（官方 RunE L ∈ [−71°,+4.3°] → −0.582）
    const pe = strafeStepPose({ speed: 5.4, phase: 0, lateralVel: -1 })
    expect(pe.thighL).toBeCloseTo((0.548 + 0.109) * Math.sin(0) - 0.56)
    expect(pe.thighL).toBeLessThan(-0.3)                            // L 后蹬
    expect(pw.yawL).toBeCloseTo(-0.90 + 0.12)                       // yaw 脚尖朝向机制保留
    expect(pw.yawR).toBeCloseTo(0.90 + 0.12)
    const pl = strafeStepPose({ speed: 5.4, phase: 0, lateralVel: -1 })
    expect(pl.yawL).toBeCloseTo(0.90 + 0.12)                        // 换侧：交叉整体镜像
    expect(pl.yawR).toBeCloseTo(-0.90 + 0.12)
    const half = strafeStepPose({ speed: 5.4, phase: Math.PI, lateralVel: 1 })
    expect(half.thighL).toBeCloseTo(pw.thighL)                      // 偏置不随相位翻转（方向性）
    expect(half.kneeL).toBeCloseTo(pw.kneeR)                        // R 腿取 p+π 相位
    // R 腿 = 反相振荡 + 反号偏置：sin(π/2)=1 → L=amp+bias、R=−amp−bias
    const q = strafeStepPose({ speed: 5.4, phase: Math.PI / 2, lateralVel: 1 })
    expect(q.thighL).toBeCloseTo((0.548 - 0.109) + 0.56)
    expect(q.thighR).toBeCloseTo(-(0.548 - 0.109) - 0.56)
  })

  it('膝曲线官方 WalkE→RunE 双锚点按速度插值：5.4=RunE 既有口径、走速以下全程 WalkE 深膝；thigh 幅不随速', () => {
    const p = strafeStepPose({ speed: 5.4, phase: 2.0, lateralVel: 1 })
    expect(p.thighL).toBeCloseTo((0.548 - 0.109) * Math.sin(2.0) + 0.56) // 幅 0.439（W 实测）+ 偏置
    expect(p.kneeL).toBeCloseTo(0.20 + 1.55 * Math.max(0, -Math.sin(2.0 - 0.5))) // 官方 RunE 膝曲线
    // 走速（3.39）及以下 = WalkE 锚点（基础 28.1°/摆动幅 60.6°）：起步拉出是深膝慢步，不再浅膝缩放
    const slow = strafeStepPose({ speed: 1.35, phase: 2.0, lateralVel: 1 })
    expect(slow.thighL).toBeCloseTo(p.thighL)                       // 方向性剪幅值不随速（官方只有跑速实测）
    expect(slow.kneeL).toBeCloseTo(0.49 + 1.06 * Math.max(0, -Math.sin(2.0 - 0.5)))
    const atWalk = strafeStepPose({ speed: 3.39, phase: 2.0, lateralVel: 1 })
    expect(atWalk.kneeL).toBeCloseTo(slow.kneeL)                   // 3.39 以下不再随速度缩幅
    // 中点线性插值（(1.35+5.4)/2 不落在锚点上，取 4.395 = t 0.5）
    const mid = strafeStepPose({ speed: 4.395, phase: 2.0, lateralVel: 1 })
    expect(mid.kneeL).toBeCloseTo((p.kneeL + slow.kneeL) / 2)
  })

  it('外展幅 0.41 + 方向偏置 ±0.155（官方 RunE [−27.6°,+20°]/RunW [−9.1°,+37.2°]）', () => {
    const pw0 = strafeStepPose({ speed: 5.4, phase: 0, lateralVel: 1 })   // s=1（右移 W）
    expect(pw0.abductL).toBeCloseTo(-0.41 + 0.155)
    expect(pw0.abductR).toBeCloseTo(0.41 + 0.155)
    const pwMid = strafeStepPose({ speed: 5.4, phase: Math.PI / 2, lateralVel: 1 }) // s=0
    expect(pwMid.abductL).toBeCloseTo(0.155)                        // 方向偏置恒在（外展不对称）
    expect(pwMid.abductR).toBeCloseTo(0.155)
    const peMid = strafeStepPose({ speed: 5.4, phase: Math.PI / 2, lateralVel: -1 }) // 左移 E
    expect(peMid.abductL).toBeCloseTo(-0.155)
    expect(peMid.abductR).toBeCloseTo(-0.155)
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

function spawnWith(lastStyles, randVal) {
  // 每次一个全新到期槽位（nextAt:-1）——出人后 nextAt 复位为 0 走排程分支，
  // 复用同一 slot 第二次调用的不是"到期出人"，只透传 lastStyles 历史
  const slot = { nextAt: -1, bot: null, lastStyles: [...(lastStyles ?? [])] }
  const bot = { peek: null, place() { } }
  // 必须走原型链（peek-delay.test.js 同款纪律）：_stepSlot 调 this._peekZ() 等
  // 原型方法，字面量对象链上找不到
  const mgr = Object.create(BotManager.prototype)
  mgr.now = () => 0
  mgr.params = { peekSide: 'left', botDistance: 13 }
  mgr.map = { gaps: [GAP], spawn: { z: SPAWN_Z } }
  mgr._bot = () => bot
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
