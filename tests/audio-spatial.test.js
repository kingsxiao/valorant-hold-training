import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { worldToListener } from '../src/core/Audio.js'

// 基准真值：three.js 相机（rotation.order 'YXZ'，rotation.y = yaw）的
// 世界→本地变换 —— 玩家 yaw 即来自该相机模型，听者坐标必须与其一致。
function threeGroundTruth(dx, dz, yaw) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'))
  const v = new THREE.Vector3(dx, 0, dz).applyQuaternion(q.invert())
  return { x: v.x, z: v.z }
}

describe('worldToListener（HRTF 听者方位换算）', () => {
  it('yaw=0 时正前方声源在听者 -Z（WebAudio 听者默认朝 -Z → 前）', () => {
    const { x, z } = worldToListener(0, -5, 0)
    expect(x).toBeCloseTo(0)
    expect(z).toBeLessThan(0)
    expect(z).toBeCloseTo(-5)
  })

  it('yaw=0 时右侧声源在听者 +X', () => {
    const { x, z } = worldToListener(5, 0, 0)
    expect(x).toBeGreaterThan(0)
    expect(z).toBeCloseTo(0)
  })

  it('yaw=0 时正后方声源在听者 +Z', () => {
    const { z } = worldToListener(0, 5, 0)
    expect(z).toBeGreaterThan(0)
  })

  it('左转 90°（yaw=+π/2，面向世界 -X）时世界 -X 方向的声源在正前', () => {
    const { x, z } = worldToListener(-5, 0, Math.PI / 2)
    expect(x).toBeCloseTo(0)
    expect(z).toBeLessThan(0)
    expect(z).toBeCloseTo(-5)
  })

  it('任意 yaw/偏移下与 three.js 相机本地系一致（随机 1000 组）', () => {
    let seed = 12345
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 1000; i++) {
      const dx = (rnd() - 0.5) * 40
      const dz = (rnd() - 0.5) * 40
      const yaw = (rnd() - 0.5) * Math.PI * 4
      const got = worldToListener(dx, dz, yaw)
      const want = threeGroundTruth(dx, dz, yaw)
      expect(got.x).toBeCloseTo(want.x, 6)
      expect(got.z).toBeCloseTo(want.z, 6)
    }
  })

  it('旧实现（cos(-yaw)/sin(-yaw) + z 取负）与 three.js 不一致 —— 回归佐证', () => {
    const oldImpl = (dx, dz, yaw) => {
      const c = Math.cos(-yaw), s = Math.sin(-yaw)
      return { x: dx * c - dz * s, z: -(dx * s + dz * c) }
    }
    const yaw = 0
    const old = oldImpl(0, -5, yaw) // 正前方声源
    const want = threeGroundTruth(0, -5, yaw)
    expect(old.z).not.toBeCloseTo(want.z, 6) // 旧实现把前方声源放到身后
  })
})
