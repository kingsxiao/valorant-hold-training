// Locomotion：官方 .psa 曲线（locomotion.json）→ AnimationClip 的构建与
// 走/跑/横移权重分配（Bot._setAnimWeights 共用的纯函数）
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import fs from 'node:fs'
import { buildClip, buildLocomotion, locoWeights, stepFootPinState } from '../src/core/Locomotion.js'

// 假骨架：UE 风格带 _NNNN 后缀骨名（与英雄 GLB 同构）
function fakeHeroSkeleton(suffixes) {
  const root = new THREE.Object3D()
  root.name = 'mesh'
  let parent = root
  for (const [plain, suf] of suffixes) {
    const b = new THREE.Bone()
    b.name = plain + '_' + suf
    parent.add(b)
    parent = b
  }
  return root
}

const JSON_CLIP = {
  duration: 0.6,
  times: [0, 0.3, 0.6],
  tracks: [
    { b: 'Pelvis', q: [0, 0, 0, 1, 0, 0.1, 0, 0.99, 0, 0, 0, 1], p: [0, 0.9, 0, 0, 0.92, 0, 0, 0.9, 0] },
    { b: 'L_Hip', q: [0, 0, 0, 1, 0.05, 0, 0, 1, 0, 0, 0, 1] },
    { b: 'Nope_Bone', q: [0, 0, 0, 1] }, // 目标骨架没有 → 跳过
  ],
}

describe('buildClip 骨名后缀解析', () => {
  it('psa 无后缀骨名 → GLB _NNNN 后缀骨名建轨道；缺骨跳过；四元数/位置原样保留', () => {
    const root = fakeHeroSkeleton([['Pelvis', '0131'], ['L_Hip', '0136']])
    const clip = buildClip(JSON_CLIP, root, 'runN')
    expect(clip.name).toBe('runN')
    expect(clip.duration).toBeCloseTo(0.6, 5)
    const names = clip.tracks.map(t => t.name)
    expect(names).toContain('Pelvis_0131.quaternion')
    expect(names).toContain('Pelvis_0131.position')
    expect(names).toContain('L_Hip_0136.quaternion')
    expect(names).not.toContain('Nope_Bone.quaternion')
    const q = clip.tracks.find(t => t.name === 'L_Hip_0136.quaternion')
    expect(q.values.length).toBe(12) // 3 帧 × 4 分量
    // KeyframeTrack 内部转 Float32（0.05 → 0.0500000007…）→ 逐分量近似比对
    JSON_CLIP.tracks[1].q.forEach((v, i) => expect(q.values[i]).toBeCloseTo(v, 6))
    const p = clip.tracks.find(t => t.name === 'Pelvis_0131.position')
    JSON_CLIP.tracks[0].p.forEach((v, i) => expect(p.values[i]).toBeCloseTo(v, 6))
  })

  it('全部骨都解析不到 → null（调用方退回烘焙）', () => {
    const root = fakeHeroSkeleton([['Spine1', '03']])
    expect(buildClip(JSON_CLIP, root)).toBeNull()
  })
})

describe('buildLocomotion 池条目集', () => {
  const locoJson = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))

  it('locomotion.json 结构锁值：官方时长（跑 0.6s / Jett 走 0.8667s / Sova 走 0.8s）、十骨轨道、盆骨/脊位置轨道在', () => {
    expect(locoJson.jett.runN.duration).toBeCloseTo(0.6, 3)
    expect(locoJson.jett.walkN.duration).toBeCloseTo(0.8667, 3)
    expect(locoJson.sova.walkN.duration).toBeCloseTo(0.8, 3)
    expect(locoJson.strafe.runE.duration).toBeCloseTo(0.6, 3)
    const bones = locoJson.jett.runN.tracks.map(t => t.b)
    expect(bones).toEqual(['Splitter', 'Pelvis', 'L_Hip', 'L_Knee', 'L_Foot', 'L_Toe', 'R_Hip', 'R_Knee', 'R_Foot', 'R_Toe'])
    expect(locoJson.jett.runN.tracks.find(t => t.b === 'Pelvis').p).toBeDefined() // 盆骨起伏轨道
    expect(locoJson.jett.runN.tracks.find(t => t.b === 'Splitter').p).toBeDefined()
    // 四元数单位性抽查（转换不破坏归一）
    const q = locoJson.sova.runN.tracks.find(t => t.b === 'L_Knee').q
    for (let i = 0; i < q.length; i += 4) {
      const n = Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3])
      expect(n).toBeCloseTo(1, 3)
    }
  })

  it('hero 键命中各自的 N 集，未知英雄回退 jett；横移集四英雄共用', () => {
    const root = fakeHeroSkeleton([['Pelvis', '9'], ['L_Hip', '9'], ['L_Knee', '9'], ['L_Foot', '9'], ['L_Toe', '9'], ['R_Hip', '9'], ['R_Knee', '9'], ['R_Foot', '9'], ['R_Toe', '9'], ['Splitter', '9']])
    const sova = buildLocomotion(locoJson, 'sova', root)
    expect(sova.walk.duration).toBeCloseTo(0.8, 3)
    expect(sova.run.duration).toBeCloseTo(0.6, 3)
    expect(sova.strafe.E.walk.tracks.length).toBeGreaterThan(0)
    const phx = buildLocomotion(locoJson, 'phoenix', root) // 未知英雄 → jett 集
    expect(phx.walk.duration).toBeCloseTo(locoJson.jett.walkN.duration, 3)
    expect(buildLocomotion({}, 'jett', root)).toBeNull() // 无数据 → null
  })
})

describe('locoWeights 走/跑/横移权重分配', () => {
  it('纯前进：idle↔walk↔run 传统三态；横移权重把 moveW 按 wS 正交分给 N 与侧移', () => {
    const w = locoWeights({ moveW: 1, runW: 0, strafeW: 0 })
    expect(w.idle).toBe(0)
    expect(w.walkN).toBe(1)
    expect(w.walkS).toBe(0)
    const half = locoWeights({ moveW: 1, runW: 0, strafeW: 0.6, hasStrafe: true })
    expect(half.walkN).toBeCloseTo(0.4, 6)
    expect(half.walkS).toBeCloseTo(0.6, 6)
    expect(half.idle).toBe(0)
  })

  it('跑速 + 全横移：runS 独占；站定：idle 独占；无侧移动作时 strafeW 被忽略', () => {
    const run = locoWeights({ moveW: 1, runW: 1, strafeW: 1, hasStrafe: true })
    expect(run.runS).toBe(1)
    expect(run.walkN).toBe(0)
    expect(run.idle).toBe(0)
    const stand = locoWeights({ moveW: 0, runW: 0, strafeW: 1, hasStrafe: true })
    expect(stand.idle).toBe(1)
    const noStrafe = locoWeights({ moveW: 1, runW: 0, strafeW: 0.8, hasStrafe: false })
    expect(noStrafe.walkN).toBe(1) // hasStrafe=false：wS 不参与（老模型无侧移动作）
  })
})

describe('stepFootPinState 脚钉地状态机（迟滞 + 权重坡）', () => {
  it('低于入锚阈值入锚、高于释放阈值释放；两阈值之间保持（迟滞带防抖）', () => {
    const st = { has: false, w: 0 }
    stepFootPinState(st, 0.15, 1 / 128)
    expect(st.has).toBe(true)
    stepFootPinState(st, 0.24, 1 / 128) // 带内：保持已锚
    expect(st.has).toBe(true)
    stepFootPinState(st, 0.27, 1 / 128)
    expect(st.has).toBe(false)
    stepFootPinState(st, 0.24, 1 / 128) // 带内：不再入锚
    expect(st.has).toBe(false)
  })

  it('权重 20/s 双向坡：16ms 一档 ~0.25，50ms 全幅；未入锚恒零', () => {
    const st = { has: false, w: 0 }
    stepFootPinState(st, 0.15, 0.016)
    expect(st.w).toBeCloseTo(0.32, 5)
    for (let i = 0; i < 5; i++) stepFootPinState(st, 0.15, 0.016) // ~96ms → 满
    expect(st.w).toBe(1)
    stepFootPinState(st, 0.3, 0.016) // 释放后衰减
    expect(st.w).toBeCloseTo(0.68, 5)
    const st2 = { has: false, w: 0 }
    stepFootPinState(st2, 0.5, 0.5)
    expect(st2.w).toBe(0)
  })

  it('阈值口径锁死：0.21/0.26（跑动支撑 ~0.15 / 摆动 0.4+ 的分离带）', () => {
    const st = { has: false, w: 0 }
    stepFootPinState(st, 0.209, 0.01)
    expect(st.has).toBe(true)
    const st3 = { has: false, w: 0 }
    stepFootPinState(st3, 0.211, 0.01)
    expect(st3.has).toBe(false)
    const st4 = { has: true, w: 1 }
    stepFootPinState(st4, 0.259, 0.01)
    expect(st4.has).toBe(true)
  })
})
