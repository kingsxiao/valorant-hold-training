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

  it('首发无累计偏移；前段垂直上抬单调不减', () => {
    const pat = makeSprayPattern(30)
    expect(pat[0].p).toBeCloseTo(0.18)
    expect(pat[0].y).toBe(0)
    for (let i = 1; i < 9; i++) expect(pat[i].p).toBeGreaterThan(pat[i - 1].p)
  })

  it('中后段出现水平摆动（非零 y）', () => {
    const pat = makeSprayPattern(30)
    const hasSway = pat.slice(8).some(({ y }) => Math.abs(y) > 0.2)
    expect(hasSway).toBe(true)
  })

  it('累计偏移量级受控（不至于打穿天）', () => {
    const pat = makeSprayPattern(30)
    for (const { p, y } of pat) {
      expect(p).toBeLessThan(15)
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
