import { describe, expect, it } from 'vitest'
import { World, raySphere } from '../src/world/World.js'

describe('World AABB 碰撞', () => {
  const makeWorld = () => {
    const w = new World()
    // 地面 y=0 + 一堵 x∈[0,2] 的墙
    w.addSolid(-10, -1, -10, 10, 0, 10)
    w.addSolid(0, 0, -1, 2, 3, 1)
    return w
  }

  it('moveAxis：水平撞墙被推出且位移被钳制', () => {
    const w = makeWorld()
    const pos = { x: -1, y: 0, z: 0 }
    const res = w.moveAxis(pos, 0.4, 1.8, 'x', 1.5) // 半径 0.4 → 触墙于 x=-0.4
    expect(res.hit).toBe(true)
    expect(pos.x).toBeCloseTo(-0.4 - 0.001, 3)
  })

  it('moveAxis：下落落地（y 轴负向命中支撑面）', () => {
    const w = makeWorld()
    const pos = { x: 5, y: 1, z: 5 }
    const res = w.moveAxis(pos, 0.4, 1.8, 'y', -2)
    expect(res.hit).toBe(true)
    expect(pos.y).toBeCloseTo(0.001, 3)
    expect(res.boundary).toBe(0)
  })

  it('moveAxis：越界参数自动 min/max 归一', () => {
    const w = new World()
    w.addSolid(2, 2, 2, 4, 4, 4) // 传反的角点
    const pos = { x: 3, y: 3, z: 3 }
    expect(w.moveAxis(pos, 0.1, 1.8, 'y', -1).hit).toBe(true)
  })

  it('raycast：命中距离/法向轴正确', () => {
    const w = makeWorld()
    const hit = w.raycast(-5, 1, 0, 1, 0, 0, 100) // 从 x=-5 朝 +X 打墙
    expect(hit).not.toBeNull()
    expect(hit.t).toBeCloseTo(5, 3)
    expect(hit.nx).toBe(-1) // 面朝 -X
    expect(hit.x).toBeCloseTo(0, 3)
  })

  it('raycast：平行掠过不命中；maxDist 外不命中；起点在盒内不命中（tmin<0 语义）', () => {
    const w = makeWorld()
    expect(w.raycast(-5, 5, 0, 1, 0, 0, 100)).toBeNull()       // 高于墙
    expect(w.raycast(-5, 1, 0, 1, 0, 0, 2)).toBeNull()         // 墙在 5m 外
    expect(w.raycast(1, 1.5, 0, 0, 1, 0, 100)).toBeNull()      // 盒内起点（近面在身后）
  })

  it('lineOfSight：墙体遮挡视线，空旷处可见', () => {
    const w = makeWorld()
    expect(w.lineOfSight(-5, 1, 0, 5, 1, 0)).toBe(false)
    expect(w.lineOfSight(-5, 1, 5, 5, 1, 5)).toBe(true)
    expect(w.lineOfSight(1, 1, 1, 1, 1, 1)).toBe(true) // 零距离
  })
})

describe('raySphere 命中球检测', () => {
  it('正对球心：t = 距离 − 半径', () => {
    expect(raySphere(0, 0, 0, 0, 0, -1, 0, 0, -10, 1)).toBeCloseTo(9, 6)
  })
  it('切线掠过不命中', () => {
    expect(raySphere(0, 0, 0, 0, 0, -1, 2, 0, -10, 1)).toBeNull()
  })
  it('球心在射线后方不命中', () => {
    expect(raySphere(0, 0, 0, 0, 0, -1, 0, 0, 10, 1)).toBeNull()
  })
  it('斜射命中点在球面（距球心 = r）', () => {
    // 射线方向 (0, 0.6, -0.8)，球心在近轴侧 (0.6, 6, -8)，最近距离 0.6 < r=1
    const t = raySphere(0, 0, 0, 0, 0.6, -0.8, 0.6, 6, -8, 1)
    expect(t).not.toBeNull()
    expect(t).toBeCloseTo(9.2, 6)
    const hit = { x: 0, y: 0.6 * t, z: -0.8 * t }
    expect(Math.hypot(hit.x - 0.6, hit.y - 6, hit.z + 8)).toBeCloseTo(1, 6)
  })
})
