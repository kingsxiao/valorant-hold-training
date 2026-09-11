import { describe, expect, it } from 'vitest'
import { Player } from '../src/player/Player.js'
import { CONFIG } from '../src/core/Config.js'

// Player 的移动/碰撞依赖注入得很干净：world 只用 moveAxis，audio 在无移动时不会被
// 调用 —— 纯 stub 即可在无渲染环境里测视角上踢恢复曲线
const worldStub = { moveAxis: () => ({ hit: false }) }
const inputStub = { down: () => false }
const mk = () => new Player(worldStub, {})

describe('视角上踢（view punch）阶跃保持模型（2026-09-11 实测重构）', () => {
  it('恢复速率取 recoil.punchRecover，指数回落精确可算', () => {
    const p = mk()
    p.addPunch(0.1, 0.02)
    p.step(0.2, inputStub, CONFIG.weapons.vandal)
    expect(p.punchPitch).toBeCloseTo(0.1 * Math.exp(-0.2 * CONFIG.weapons.vandal.recoil.punchRecover), 5)
  })

  it('阶跃保持：停火 0.75s 残留 >99%（实测上界，全武器统一速率）', () => {
    const p = mk()
    p.addPunch(0.1, 0)
    p.step(0.75, inputStub, CONFIG.weapons.sheriff)
    expect(p.punchPitch).toBeGreaterThan(0.099)
  })

  it('武器无 recoil 参数（刀）回退默认恢复率 9/s', () => {
    const p = mk()
    p.addPunch(0.1, 0)
    p.step(0.1, inputStub, CONFIG.weapons.knife)
    expect(p.punchPitch).toBeCloseTo(0.1 * Math.exp(-0.1 * 9), 5)
  })

  it('上踢回落不影响真实视角（pitch/yaw 不被恢复项改动）', () => {
    const p = mk()
    p.pitch = 0.3; p.yaw = -0.5
    p.addPunch(0.1, 0.02)
    p.step(0.1, inputStub, CONFIG.weapons.vandal)
    expect(p.pitch).toBe(0.3)
    expect(p.yaw).toBe(-0.5)
  })
})
