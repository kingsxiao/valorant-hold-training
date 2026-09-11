import { describe, expect, it } from 'vitest'
import { CONFIG, makeSprayPattern } from '../src/core/Config.js'
import { reseed, vary, varyRange } from '../src/core/Rng.js'

describe('武器数值表完整性（CONFIG.weapons）', () => {
  const ids = Object.keys(CONFIG.weapons)

  it('每把枪具备必备字段且为正数', () => {
    for (const id of ids) {
      const w = CONFIG.weapons[id]
      expect(w.name, id).toBeTruthy()
      expect(w.fireRate, id).toBeGreaterThan(0)
      expect(w.magSize, id).toBeGreaterThan(0) // 弹药无限 = Infinity
      expect(w.slot, id).toBeTruthy()
      if (w.slot !== 'melee') {
        expect(w.equipTime, id).toBeGreaterThan(0)
        expect(w.spread.stand, id).toBeLessThan(w.spread.run)
        expect(w.recoil.recoverTime, id).toBeGreaterThan(0)
        // 视角上踢恢复：阶跃保持模型（实测 750ms 回稳 <1% → rate <0.013/s，取 0.01）
        expect(w.recoil.punchRecover, id).toBeGreaterThan(0.005)
        expect(w.recoil.punchRecover, id).toBeLessThan(0.02)
        // 散布锚点单调：静止 < 走路 < 全速 < 跳跃；连射上限高于首发
        expect(w.spread.stand, id).toBeLessThan(w.spread.walk)
        expect(w.spread.walk, id).toBeLessThan(w.spread.run)
        expect(w.spread.run, id).toBeLessThan(w.spread.jump)
        expect(w.spread.max, id).toBeGreaterThan(w.spread.stand)
        expect(w.spread.crouchMove, id).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('枪械伤害 head > body > leg（爆头有意义、腿部有减免）；近战三段等伤', () => {
    for (const id of ids) {
      const w = CONFIG.weapons[id]
      const d = w.damage
      if (w.slot === 'melee') {
        expect(d.head, id).toBe(d.body)
        expect(d.body, id).toBe(d.leg)
      } else {
        expect(d.head, id).toBeGreaterThan(d.body)
        expect(d.body, id).toBeGreaterThan(d.leg)
      }
    }
  })

  it('falloff 档位按距离升序且最后一档为 Infinity', () => {
    for (const id of ids) {
      const f = CONFIG.weapons[id].falloff
      if (!f) continue
      expect(f.length, id).toBeGreaterThan(1)
      for (let i = 1; i < f.length; i++) expect(f[i].maxDist, id).toBeGreaterThan(f[i - 1].maxDist)
      expect(f[f.length - 1].maxDist, id).toBe(Infinity)
      for (const tier of f) {
        expect(tier.damage.head, id).toBeGreaterThan(tier.damage.body)
        expect(tier.damage.body, id).toBeGreaterThan(tier.damage.leg)
      }
    }
  })

  it('近战有射程，枪械没有（射程字段仅刀使用）', () => {
    for (const id of ids) {
      const w = CONFIG.weapons[id]
      if (w.slot === 'melee') expect(w.range, id).toBeGreaterThan(0)
      else expect(w.range, id).toBeUndefined()
    }
  })

  // 切枪时长 = 维基 equip 三档的 Normal（2026-09 复核）：步枪/Sheriff 1.0 ·
  // 手枪 0.75 · 近战 0.6。Fast/Instant 档（技能后/特定能力交互）无对应路径不取
  it('equipTime 锁维基 Normal 档（步枪 1.0 / 手枪 0.75 / 近战 0.6）', () => {
    expect(CONFIG.weapons.vandal.equipTime).toBe(1.0)
    expect(CONFIG.weapons.phantom.equipTime).toBe(1.0)
    expect(CONFIG.weapons.sheriff.equipTime).toBe(1.0)
    expect(CONFIG.weapons.classic.equipTime).toBe(0.75)
    expect(CONFIG.weapons.ghost.equipTime).toBe(0.75)
    expect(CONFIG.weapons.knife.equipTime).toBe(0.6)
  })
})

describe('makeSprayPattern 后坐力弹道表', () => {
  it('长度按需生成，全部为有限数', () => {
    for (const n of [1, 10, 25, 30]) {
      const pat = makeSprayPattern(n)
      expect(pat).toHaveLength(n)
      for (const { p, y } of pat) {
        expect(Number.isFinite(p)).toBe(true)
        expect(Number.isFinite(y)).toBe(true)
      }
    }
  })

  it('首发无累计偏移；前段垂直上抬单调不减（默认 climb=16 实测标定）', () => {
    const pat = makeSprayPattern(30)
    expect(pat[0].p).toBeCloseTo(0.71, 1) // 0.18 × 16/4.03（默认 climb=16）
    expect(pat[0].y).toBe(0)
    for (let i = 1; i < 9; i++) expect(pat[i].p).toBeGreaterThan(pat[i - 1].p)
  })

  it('实测标定锁值：Vandal 25 发累计爬升 ≈ 18°（四 take 双确认中位）、Phantom ≈ 17°（独立三样本）', () => {
    const vd = makeSprayPattern(25, { prot: 6, swing: 5.85, climb: CONFIG.weapons.vandal.recoil.climb })
    const ph = makeSprayPattern(25, { prot: 8, swing: 6.6, climb: CONFIG.weapons.phantom.recoil.climb })
    expect(vd[24].p).toBeGreaterThan(17.5)
    expect(vd[24].p).toBeLessThan(18.5)
    expect(ph[24].p).toBeGreaterThan(16.5)
    expect(ph[24].p).toBeLessThan(17.5)
    // 曲线里程碑（保持原形状只放大总幅）：3 发 ~14%、9 发 ~87%、13 发 ~95%
    expect(vd[2].p / vd[24].p).toBeGreaterThan(0.12)
    expect(vd[2].p / vd[24].p).toBeLessThan(0.17)
    expect(vd[8].p / vd[24].p).toBeGreaterThan(0.84)
    expect(vd[8].p / vd[24].p).toBeLessThan(0.90)
    expect(vd[12].p / vd[24].p).toBeGreaterThan(0.93)
    expect(vd[12].p / vd[24].p).toBeLessThan(0.97)
  })

  it('水平摆幅包络点值锁（逐孔级复测确认）：Vandal 单侧 ≈1.0°±0.15（phantom 13 孔实测 0.45° 与模型段预测 0.42° 吻合、vandal T4 近零实现 → 随机化实现带 [0.1,2.4]，包络居中）', () => {
    const vd = makeSprayPattern(30, { prot: 6, swing: 5.85, climb: 18 })
    const maxY = Math.max(...vd.map(({ y }) => Math.abs(y)))
    expect(maxY).toBeGreaterThan(0.85)
    expect(maxY).toBeLessThan(1.15)
    // phantom 13 发段模型单侧 ≈0.42°（实测 0.45 吻合）
    const ph = makeSprayPattern(13, { prot: 8, swing: 6.6, climb: 17 })
    const phMax = Math.max(...ph.map(({ y }) => Math.abs(y)))
    expect(phMax).toBeGreaterThan(0.3)
    expect(phMax).toBeLessThan(0.55)
    // 方向结构先验（bo3.gg/VALTRAIN 记载，幅度与列形观测脱钩——倾斜为偏航伪影）
    expect(Math.min(...vd.slice(6, 18).map(({ y }) => y))).toBeLessThan(-0.4)
    expect(Math.max(...vd.slice(18).map(({ y }) => y))).toBeGreaterThan(0.4)
  })

  it('半自动武器多样本锁值：弹匣段累计（Sheriff ≈18.9 三样本压枪分离 / Classic ≈15.0 / Ghost ≈19.7 判据复核通过）', () => {
    const seg = (climb, count) => makeSprayPattern(count, { prot: 6, swing: 5.9, climb })[count - 1].p
    const sh = seg(CONFIG.weapons.sheriff.recoil.climb, 6)
    const cl = seg(CONFIG.weapons.classic.recoil.climb, 12)
    const gh = seg(CONFIG.weapons.ghost.recoil.climb, 13)
    // Sheriff 带宽 = 无压枪对均值 ± 对内离散 ±0.95
    expect(sh).toBeGreaterThan(17.9); expect(sh).toBeLessThan(19.9)
    expect(cl).toBeGreaterThan(14.4); expect(cl).toBeLessThan(15.6)
    expect(gh).toBeGreaterThan(18.7); expect(gh).toBeLessThan(20.7)
    // per-shot 后坐排序（双样本维持）：Sheriff > Ghost > Classic
    expect(sh / 6).toBeGreaterThan(gh / 13)
    expect(gh / 13).toBeGreaterThan(cl / 12)
  })

  it('中后段出现水平摆动（非零 y）', () => {
    const pat = makeSprayPattern(30)
    const hasSway = pat.slice(8).some(({ y }) => Math.abs(y) > 0.2)
    expect(hasSway).toBe(true)
  })

  it('水平保护窗：前 prot 发 y 恒为 0，窗后按换向节拍摆动（公开补丁机制）', () => {
    const pat = makeSprayPattern(30, { prot: 6, swing: 5.85 })
    for (let i = 0; i < 6; i++) expect(pat[i].y).toBe(0)
    expect(Math.abs(pat[7].y)).toBeGreaterThan(0) // 保护窗后第一发即开始有横偏
    expect(pat.slice(6).some(({ y }) => Math.abs(y) > 0.3)).toBe(true)
  })

  it('保护弹数按武器配置（Phantom 8 发比 Vandal 6 发更晚进入水平段）', () => {
    const v = makeSprayPattern(30, { prot: CONFIG.weapons.vandal.recoil.protected, swing: 0.6 * CONFIG.weapons.vandal.fireRate })
    const p = makeSprayPattern(30, { prot: CONFIG.weapons.phantom.recoil.protected, swing: 0.6 * CONFIG.weapons.phantom.fireRate })
    for (let i = 6; i < 8; i++) expect(p[i].y).toBe(0)
    expect(Math.abs(v[7].y)).toBeGreaterThan(0)
  })

  it('水平段先右后左（文档记载：Phantom rightward lean→pull left；Vandal 补偿左下=弹道右上漂）', () => {
    const pat = makeSprayPattern(30, { prot: 6, swing: 5.85 })
    expect(pat[7].y).toBeLessThan(0) // 保护窗后第一发向右漂（本表 y 负 = 向右）
    expect(pat.slice(6, 12).some(({ y }) => y < -0.1)).toBe(true) // 前半摆向右
    expect(pat.slice(12).some(({ y }) => y > 0.1)).toBe(true)     // 后半拉回左
  })

  it('垂直分量全程不下坠：爬升后进高位平台（压枪量封顶，不回落）', () => {
    // 曾有后段逐发 -0.1° 的下坠：压枪过冲后要反向上推，与目标游戏的
    // "前段爬升→平台→水平摆动"形状相悖 —— 此用例锁死回归
    const pat = makeSprayPattern(30)
    for (let i = 1; i < pat.length; i++) expect(pat[i].p).toBeGreaterThanOrEqual(pat[i - 1].p)
  })

  it('消音武器带 suppressed 标记（开火视觉收敛用），非消音不带', () => {
    expect(CONFIG.weapons.phantom.suppressed).toBe(true)
    expect(CONFIG.weapons.ghost.suppressed).toBe(true)
    for (const id of ['vandal', 'sheriff', 'classic', 'knife']) {
      expect(CONFIG.weapons[id].suppressed, id).toBeUndefined()
    }
  })

  it('累计偏移量级受控（不至于打穿天）', () => {
    const pat = makeSprayPattern(30)
    for (const { p, y } of pat) {
      expect(p).toBeLessThan(20)
      expect(Math.abs(y)).toBeLessThan(10)
    }
  })
})

describe('Rng（mulberry32 可复现伪随机）', () => {
  it('同种子序列完全一致', () => {
    reseed(42)
    const a = Array.from({ length: 100 }, vary)
    reseed(42)
    const b = Array.from({ length: 100 }, vary)
    expect(a).toEqual(b)
  })

  it('输出在 [0,1) 区间', () => {
    reseed(Date.now() | 1)
    for (let i = 0; i < 10000; i++) {
      const v = vary()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('varyRange 结果落在给定区间内', () => {
    reseed(7)
    for (let i = 0; i < 1000; i++) {
      const v = varyRange(-3, 5)
      expect(v).toBeGreaterThanOrEqual(-3)
      expect(v).toBeLessThanOrEqual(5)
    }
  })

  it('reseed(0) 不会把状态卡死在 0（仍能产出多样化值）', () => {
    reseed(0)
    const vals = new Set(Array.from({ length: 50 }, vary))
    expect(vals.size).toBeGreaterThan(40)
  })
})

describe('vmKick 实测下修 + 枪口缓升（60fps 质心实测）', () => {
  it('每发平移冲量 ≈0.004 量级（官方开火中枪体质心 σ≈0.1px，每发踢 <1px@1080p → ×0.125）', () => {
    const k = CONFIG.weapons
    expect(k.vandal.vmKick).toBeGreaterThan(0.002)
    expect(k.vandal.vmKick).toBeLessThan(0.006)
    expect(k.sheriff.vmKick).toBeGreaterThan(k.vandal.vmKick) // 左轮最重
    expect(k.ghost.vmKick).toBeLessThan(k.vandal.vmKick)      // 消音最轻
  })
  it('枪口缓升系数 0.0035 rad/°弹道：25 发 ≈3.6°（官方 2.4px/发 ×25 ≈4°）', () => {
    // 纯值锁（VM_RISE = 0.0035 rad/°，vandal 25 发弹道 18°）
    expect(18 * 0.0035 * 180 / Math.PI).toBeGreaterThan(3.2)
    expect(18 * 0.0035 * 180 / Math.PI).toBeLessThan(4.2)
  })
})

describe('punchRecover 阶跃保持模型（60fps 实测）', () => {
  it('全武器统一 ≈0.01/s：停火后偏移保持（750ms 回稳 <1% 实测上界）', () => {
    for (const id of ['vandal', 'phantom', 'sheriff', 'classic', 'ghost']) {
      expect(CONFIG.weapons[id].recoil.punchRecover).toBe(0.01)
    }
  })
  it('视角爬升预算：每发 punch = 弹道增量×viewPunch×0.25 → vandal 全弹匣 ≈1.5°（实测 1.0-1.5°）', () => {
    const pat = makeSprayPattern(25, { prot: 6, swing: 5.85, climb: 18 })
    let sum = 0; let prev = 0
    for (const { p } of pat) { sum += (p - prev) * 0.34 * 0.25; prev = p }
    expect(sum).toBeGreaterThan(1.2)
    expect(sum).toBeLessThan(1.8)
  })
})

describe('蹲姿对枪 crouchChance', () => {
  it('默认 0.3（急停瞬间掷蹲姿对枪的本体口径）', () => {
    expect(CONFIG.training.crouchChance).toBe(0.3)
  })
})

describe('蹲走拉出 crouchWalkChance', () => {
  it('默认 0.2（pull 波掷定蹲走拉出变体）', () => {
    expect(CONFIG.training.crouchWalkChance).toBe(0.2)
  })
})
