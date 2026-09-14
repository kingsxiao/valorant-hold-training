// 蹲族 IK 锚数据修复回归门（165 轮，scripts/psa2clips.mjs 的三刀修复）：
//  1) δ 下沉：蹲踞/蹲走 E/W 坏侧锚 z 平台回到好侧同高（脚不悬空）
//  2) z 压平：坏侧 stance 窗内 z 恒平台（整窗落地约束）
//  3) y 线性化（仅 W）：窗内横向扫速恒官方口径 2×0.735/周期
// 数据被 psa2clips 重新生成意外回退时，这里第一时间红
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const loco = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../public/models/locomotion.json'), 'utf8'))
const zOf = (clip, side) => Array.from({ length: clip.n }, (_, i) => clip.ik[side][i * 3 + 2])
const yOf = (clip, side) => Array.from({ length: clip.n }, (_, i) => clip.ik[side][i * 3 + 1])

describe('全库锚 z 平台普查（两侧都触地，0.115~0.137 带内）', () => {
  // 带宽含官方天然差异（走E 两侧差 5mm、蹲走SE/SW 最低 0.136、NW 0.1157
  // ——均为未修复 clip 的原始数据）；被修复的三条曲线由下方专项 describe
  // 用更紧的断言锁定
  const cases = [
    ['core.walkN', '走N'], ['core.walkE', '走E'], ['core.walkW', '走W'],
    ['core.runN', '跑N'], ['core.runE', '跑E'], ['core.runW', '跑W'],
    ['crouch.idle', '蹲踞'], ['crouch.walkN', '蹲走N'], ['crouch.walkE', '蹲走E'],
    ['crouch.walkW', '蹲走W'], ['crouch.walkNE', '蹲走NE'], ['crouch.walkNW', '蹲走NW'],
    ['crouch.walkSE', '蹲走SE'], ['crouch.walkSW', '蹲走SW'],
  ]
  for (const [path, label] of cases) {
    it(`${label} 两侧都触地（带 0.115~0.137，差 ≤6mm）`, () => {
      const clip = path.split('.').reduce((o, k) => o[k], loco)
      for (const side of ['L', 'R']) {
        const zMin = Math.min(...zOf(clip, side))
        expect(zMin, `${label} ${side} 侧最低锚`).toBeGreaterThanOrEqual(0.115)
        expect(zMin, `${label} ${side} 侧最低锚`).toBeLessThanOrEqual(0.137)
      }
      const lMin = Math.min(...zOf(clip, 'L'))
      const rMin = Math.min(...zOf(clip, 'R'))
      expect(Math.abs(lMin - rMin), `${label} 两侧平台差`).toBeLessThanOrEqual(0.006)
    })
  }
})

describe('蹲踞 δ 下沉（165 轮第一刀）', () => {
  it('两侧锚 z 恒等且为平台高（修复前 R 侧恒 +4.9cm 悬空）', () => {
    const clip = loco.crouch.idle
    const zL = zOf(clip, 'L'), zR = zOf(clip, 'R')
    // 恒定曲线：全帧同值
    expect(new Set(zL).size).toBe(1)
    expect(new Set(zR).size).toBe(1)
    expect(Math.abs(zL[0] - zR[0])).toBeLessThanOrEqual(0.001)
  })
})

describe('蹲走坏侧 stance 窗重建（165 轮第二/三刀）', () => {
  it('walkE R：f09-f17 z 压平到平台（±1mm）', () => {
    const clip = loco.crouch.walkE
    const z = zOf(clip, 'R')
    const plat = Math.min(...z)
    for (let i = 9; i <= 17; i++) {
      expect(Math.abs(z[i] - plat), `f${i}`).toBeLessThanOrEqual(0.001)
    }
  })
  it('walkW L：f19-f03（环回）z 压平 + y 恒官方口径扫速', () => {
    const clip = loco.crouch.walkW
    const z = zOf(clip, 'L'), y = yOf(clip, 'L')
    const plat = Math.min(...z)
    const n = clip.n
    for (let k = 0; k <= ((3 - 19 + n) % n); k++) {
      const i = (19 + k) % n
      expect(Math.abs(z[i] - plat), `f${i}`).toBeLessThanOrEqual(0.001)
    }
    // y 线性：窗内相邻帧差恒定（±0.1mm 浮点容差）
    const frameDt = clip.duration / (n - 1)
    const rate = 0.735 * 2 / clip.duration // 官方口径 1.577 m/s
    const steps = (3 - 19 + n) % n
    const expectedStep = -rate * frameDt // W 净扫向 = y 递减
    for (let k = 1; k <= steps; k++) {
      const d = y[(19 + k) % n] - y[(19 + k - 1) % n]
      expect(Math.abs(d - expectedStep), `f19+${k} 的 y 步进`).toBeLessThanOrEqual(0.0001)
    }
  })
  it('walkW L：净扫幅对官方口径（touchdown 值不动，±1cm）', () => {
    const clip = loco.crouch.walkW
    const y = yOf(clip, 'L')
    const n = clip.n
    const steps = (3 - 19 + n) % n
    const sweep = Math.abs(y[3] - y[19])
    const canon = 0.735 * 2 / clip.duration * steps * (clip.duration / (n - 1))
    expect(Math.abs(sweep - canon)).toBeLessThanOrEqual(0.01)
    // touchdown 端点（f19）保持官方原值
    expect(Math.abs(y[19] - 0.801)).toBeLessThanOrEqual(0.002)
  })
})
