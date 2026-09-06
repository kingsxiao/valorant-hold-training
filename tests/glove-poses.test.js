import { describe, it, expect } from 'vitest'
import { GLOVE_POSES, ARMS_POSES } from '../src/weapons/HandsRig.js'

// 第五十六~八十轮收敛的握姿数值回归锁定：这些腕锚/卷曲是顶点级穿插检测 +
// 三轴坐标下降 + 视觉验收的产物（详见 HandsRig.js 内各注释），任何改动都应
// 经过同等审计而非随手调整——改这里 = 有意改变握姿，请同步更新本测试。
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky']

describe('GLOVE_POSES 握姿表结构', () => {
  it('包含 default/vandal/phantom 三套，且各含双手', () => {
    for (const id of ['default', 'vandal', 'phantom']) {
      expect(GLOVE_POSES[id], id).toBeTruthy()
      expect(GLOVE_POSES[id].handR, id).toBeTruthy()
      expect(GLOVE_POSES[id].handL, id).toBeTruthy()
    }
  })

  it('腕锚/掌向为 3 元数值向量；curls 为五指 × 4 关节（数值或 [x,y,z]）', () => {
    for (const [id, pose] of Object.entries(GLOVE_POSES)) {
      for (const side of ['handR', 'handL']) {
        const h = pose[side]
        for (const key of ['wrist', 'fDes', 'sDes']) {
          expect(h[key], `${id}.${side}.${key}`).toHaveLength(3)
          h[key].forEach(v => expect(typeof v, `${id}.${side}.${key}`).toBe('number'))
        }
        for (const f of FINGERS) {
          const joints = h.curls[f]
          expect(joints, `${id}.${side}.curls.${f}`).toHaveLength(4)
          joints.forEach(j => {
            const arr = Array.isArray(j) ? j : [j]
            expect(arr.length, `${id}.${side}.curls.${f}`).toBeLessThanOrEqual(3)
            arr.forEach(v => expect(typeof v).toBe('number'))
          })
        }
      }
    }
  })

  it('vandal/phantom 右手镜像、左手原生（模型本体为左手）', () => {
    expect(GLOVE_POSES.vandal.handR.mirror).toBe(true)
    expect(GLOVE_POSES.phantom.handR.mirror).toBe(true)
    expect(GLOVE_POSES.vandal.handL.mirror).toBeFalsy()
    expect(GLOVE_POSES.phantom.handL.mirror).toBeFalsy()
  })
})

describe('已收敛握姿数值锁定（穿插清零与零缝隙的成果）', () => {
  it('vandal 腕锚：右腕 z=-0.317（腕口穿插清零）、左腕 x=-1.35', () => {
    expect(GLOVE_POSES.vandal.handR.wrist).toEqual([1.7, 0.1, -0.317])
    expect(GLOVE_POSES.vandal.handL.wrist[0]).toBeCloseTo(-1.35, 3)
  })

  it('phantom 腕锚：右腕保持原始 -0.09（让位已回退）、左腕 z=0.016', () => {
    expect(GLOVE_POSES.phantom.handR.wrist).toEqual([0.42, 0.1, -0.09])
    expect(GLOVE_POSES.phantom.handL.wrist).toEqual([-0.2, 0.05, 0.016])
  })

  it('vandal 左手四指中节贴面（Y+20° 或 Z 轴指向在数组第 2/3 位）', () => {
    const c = GLOVE_POSES.vandal.handL.curls
    expect(c.index[2]).toEqual([97, 20, 0])
    expect(c.ring[2]).toEqual([103, 20, -6])
  })

  it('phantom 左手中节回卷 + Z 轴贴面指向（管径小需回卷）', () => {
    const c = GLOVE_POSES.phantom.handL.curls
    expect(c.ring[2]).toEqual([80, 0, -20])
    expect(c.index[3]).toBe(20)
  })

  it('拇指对握：两枪左手拇指指根均为 [x,y,z] 三轴格式', () => {
    expect(Array.isArray(GLOVE_POSES.vandal.handL.curls.thumb[0])).toBe(true)
    expect(Array.isArray(GLOVE_POSES.phantom.handL.curls.thumb[0])).toBe(true)
  })

  it('vandal 右手食指扣扳机位（近/中/远节多轴卷曲）', () => {
    const idx = GLOVE_POSES.vandal.handR.curls.index
    expect(idx[1]).toEqual([90, 30, 30])
    expect(idx[3]).toEqual([45, 0, 30])
  })
})

describe('ARMS_POSES 回退路径表（第六十五轮）', () => {
  it('default/vandal/phantom 各含双腕锚与六瞄准点', () => {
    for (const id of ['default', 'vandal', 'phantom']) {
      const P = ARMS_POSES[id]
      expect(P.wristR, id).toHaveLength(3)
      expect(P.wristL, id).toHaveLength(3)
      for (const side of ['aimR', 'aimL']) {
        for (const f of ['dbl', 'idx', 'thb']) {
          expect(P[side][f], `${id}.${side}.${f}`).toHaveLength(3)
        }
      }
    }
  })
})
