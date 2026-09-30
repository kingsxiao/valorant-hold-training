// 走廊硬域一致性锁（corridor-constants-no-lock）：训练不变量此前三处手抄无锁
// （MapBuilder 墙盒 / BotManager 钳位死值 / 测试注释），改墙厚/位置会静默失效
// （Bot 贴/穿墙、firstVisibleAt 恒 -1）。现在单一事实源 src/world/corridor.js，
// 本测试锁四层：
//  1. corridor.js 派生数值 = 历史手抄死值（改动必须有意为之且同步全链）
//  2. 几何语义不变量（玩家区/横移带隔离、硬域含菜单全域、后墙余量）
//  3. BotManager._peekZ/_hideOff 消费同一常量（行为级，污染钳位兜底）
//  4. MapBuilder 文本锁（node 环境不可实例化——源码必须 import corridor 常量，
//     手法同 tests/prewarm-arrival.test.js 源码文本锁）
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DOOR_WALL_Z, DOOR_WALL_THICK, DOOR_WALL_FAR_Z, DOOR_WALL_NEAR_Z,
  BACK_WALL_Z, BACK_WALL_THICK, BACK_WALL_NEAR_Z,
  PEEK_Z_MARGIN, PEEK_Z_MIN, PEEK_Z_MAX, GAP_LEFT, GAP_RIGHT, SPAWN_Z,
} from '../src/world/corridor.js'
import { BotManager } from '../src/entities/BotManager.js'

describe('corridor.js 派生数值锁（历史手抄死值锚定）', () => {
  it('墙盒原值与四个派生面：门墙 z∈[-24.8,-23.2]、后墙内面 -35.6', () => {
    expect(DOOR_WALL_Z).toBe(-24)
    expect(DOOR_WALL_THICK).toBe(1.6)
    expect(DOOR_WALL_FAR_Z).toBeCloseTo(-24.8, 12) // 派生式自检（非手抄第二份）
    expect(DOOR_WALL_FAR_Z).toBe(DOOR_WALL_Z - DOOR_WALL_THICK / 2)
    expect(DOOR_WALL_NEAR_Z).toBe(DOOR_WALL_Z + DOOR_WALL_THICK / 2)
    expect(BACK_WALL_Z).toBe(-36)
    expect(BACK_WALL_THICK).toBe(0.8)
    expect(BACK_WALL_NEAR_Z).toBe(BACK_WALL_Z + BACK_WALL_THICK / 2)
  })

  it('硬域/缺口/出生位：-35.2 / -25.2 / 左窄口右宽口 / spawn -17', () => {
    expect(PEEK_Z_MIN).toBe(BACK_WALL_NEAR_Z + PEEK_Z_MARGIN)
    expect(PEEK_Z_MAX).toBe(DOOR_WALL_FAR_Z - PEEK_Z_MARGIN)
    expect(PEEK_Z_MIN).toBe(-35.2)
    expect(PEEK_Z_MAX).toBe(-25.2)
    expect(GAP_LEFT).toEqual({ x0: -9, x1: -6 })
    expect(GAP_RIGHT).toEqual({ x0: 3, x1: 7 })
    expect(SPAWN_Z).toBe(-17)
  })
})

describe('走廊几何语义不变量', () => {
  it('横移硬域整体在门墙远面之后（玩家区与 Bot 带被墙完全隔开）且不进后墙体', () => {
    expect(PEEK_Z_MAX).toBeLessThan(DOOR_WALL_FAR_Z) // Bot 最靠前仍留 0.4m 墙厚余量
    expect(PEEK_Z_MIN).toBeGreaterThan(BACK_WALL_NEAR_Z) // 最深不贴后墙内面
    expect(SPAWN_Z).toBeGreaterThan(DOOR_WALL_NEAR_Z) // 出生位在玩家区（门墙近面之前）
  })

  it('菜单 botDistance 全域 [9,18] 换算硬域内：硬钳只兜污染不吞正常档位', () => {
    for (const d of [9, 12, 16, 18]) {
      const z = SPAWN_Z - d
      expect(z).toBeGreaterThanOrEqual(PEEK_Z_MIN)
      expect(z).toBeLessThanOrEqual(PEEK_Z_MAX)
    }
  })

  it('楔形投影分母（bot-distance.test TO_WALL 口径）：spawn.z − 门墙远面 = 7.8', () => {
    expect(SPAWN_Z - DOOR_WALL_FAR_Z).toBeCloseTo(7.8, 12)
  })
})

describe('BotManager 消费同源（行为级）', () => {
  const mgr = (spawnZ = SPAWN_Z) => {
    const m = Object.create(BotManager.prototype)
    m.map = { gaps: [GAP_LEFT], spawn: { z: spawnZ } }
    m.params = {}
    return m
  }

  it('_peekZ：9-18 全域线性换算；污染值（1/100）被钳回硬域两端', () => {
    const m = mgr()
    m.params.botDistance = 9
    expect(m._peekZ()).toBe(SPAWN_Z - 9)
    m.params.botDistance = 18
    expect(m._peekZ()).toBe(SPAWN_Z - 18)
    m.params.botDistance = 1 // 低于硬域近端 → 钳 PEEK_Z_MAX
    expect(m._peekZ()).toBe(PEEK_Z_MAX)
    m.params.botDistance = 100 // 超过硬域远端 → 钳 PEEK_Z_MIN
    expect(m._peekZ()).toBe(PEEK_Z_MIN)
  })

  it('_hideOff 消费门墙远面：13m 原值 2.2 起步、16m 右宽口外扩 2.603（历史标定）', () => {
    const m = mgr()
    expect(m._hideOff(GAP_LEFT, SPAWN_Z - 13)).toBe(2.2) // 旧固定常量原值保留
    expect(m._hideOff(GAP_RIGHT, SPAWN_Z - 16)).toBeCloseTo(2.603, 3)
  })
})

describe('MapBuilder 文本锁（node 不可实例化，锁同源 import 在用）', () => {
  const read = (p) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8')

  it('墙盒/缺口/出生位走 corridor 常量，手抄死值不得回归', () => {
    const src = read('src/world/MapBuilder.js')
    for (const k of ['DOOR_WALL_Z', 'DOOR_WALL_THICK', 'DOOR_WALL_NEAR_Z', 'BACK_WALL_Z', 'BACK_WALL_THICK', 'GAP_LEFT', 'GAP_RIGHT', 'SPAWN_Z']) {
      expect(src, `MapBuilder 必须消费 corridor.${k}`).toContain(k)
    }
    expect(src, '门墙近面死值恢复即报警（原 const doorFace = -23.2）').not.toContain('-23.2')
    expect(src, 'spawn 深度死值恢复即报警').not.toContain('z: -17')
  })

  it('BotManager 不得恢复本地钳位死值（单一事实源=corridor.js）', () => {
    const src = read('src/entities/BotManager.js')
    expect(src).toContain("from '../world/corridor.js'")
    expect(src, '本地死值恢复即报警').not.toContain('const DOOR_WALL_FAR_Z')
  })
})
