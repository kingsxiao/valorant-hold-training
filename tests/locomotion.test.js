// Locomotion：官方 .psa 曲线（locomotion.json）→ AnimationClip 的构建与
// 走/跑/横移权重分配（Bot._setAnimWeights 共用的纯函数）
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import fs from 'node:fs'
import { buildClip, buildLocomotion, locoWeights, stepFootPinState, sampleIkAnchor, pickDeathSide, pickTurnClip, crouchWalkStepFor, CROUCH_WALK_SPEED } from '../src/core/Locomotion.js'

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

  it('locomotion.json 结构锁值：TP_Core 官方时长（跑 0.6s / 走 0.8667s）、十骨轨道、盆骨位置轨道在', () => {
    expect(locoJson.core.runN.duration).toBeCloseTo(0.6, 3)
    expect(locoJson.core.walkN.duration).toBeCloseTo(0.8667, 3)
    expect(locoJson.core.walkE.duration).toBeCloseTo(0.8667, 3) // E/W 真方向性循环（同为走时长）
    expect(locoJson.core.runW.duration).toBeCloseTo(0.6, 3)
    expect(locoJson.strafe.runE.duration).toBeCloseTo(0.6, 3)
    const bones = locoJson.core.runN.tracks.map(t => t.b)
    expect(bones).toEqual(['Splitter', 'Pelvis', 'L_Hip', 'L_Knee', 'L_Foot', 'L_Toe', 'R_Hip', 'R_Knee', 'R_Foot', 'R_Toe'])
    expect(locoJson.core.runN.tracks.find(t => t.b === 'Pelvis').p).toBeDefined() // 盆骨起伏轨道
    expect(locoJson.core.runN.tracks.find(t => t.b === 'Splitter').p).toBeDefined()
    // 方向性抽查：TP_Core 的 RunE 是真横移（腿轨道 ≠ RunN 导出复件——旧 Jett X_Knives 集是复件）
    const runN = locoJson.core.runN.tracks.find(t => t.b === 'L_Knee').q
    const runE = locoJson.core.runE.tracks.find(t => t.b === 'L_Knee').q
    expect(runN).not.toEqual(runE)
    // 四元数单位性抽查（转换不破坏归一）
    const q = locoJson.core.runN.tracks.find(t => t.b === 'L_Knee').q
    for (let i = 0; i < q.length; i += 4) {
      const n = Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3])
      expect(n).toBeCloseTo(1, 3)
    }
  })

  it('各英雄共用 core 集（本体移动全英雄同款 TP_Core），横移集同源；无数据回退 null', () => {
    const root = fakeHeroSkeleton([['Pelvis', '9'], ['L_Hip', '9'], ['L_Knee', '9'], ['L_Foot', '9'], ['L_Toe', '9'], ['R_Hip', '9'], ['R_Knee', '9'], ['R_Foot', '9'], ['R_Toe', '9'], ['Splitter', '9']])
    const jett = buildLocomotion(locoJson, 'jett', root)
    expect(jett.walk.duration).toBeCloseTo(0.8667, 3)
    expect(jett.run.duration).toBeCloseTo(0.6, 3)
    expect(jett.strafe.E.walk.tracks.length).toBeGreaterThan(0)
    expect(jett.strafe.W.run.tracks.length).toBeGreaterThan(0)
    const phx = buildLocomotion(locoJson, 'phoenix', root) // 未知英雄 → 同 core 集
    expect(phx.walk.duration).toBe(jett.walk.duration)
    expect(buildLocomotion({}, 'jett', root)).toBeNull() // 无数据 → null
  })

  it('buildClip 挂官方 IK 目标锚曲线到 clip.userData（不进 mixer 轨道）', () => {
    const root = fakeHeroSkeleton([['Pelvis', '9'], ['L_Hip', '9']])
    const clip = buildClip({ duration: 0.6, times: [0, 0.6], ik: { L: [1, 2, 3, 4, 5, 6] }, tracks: [{ b: 'Pelvis', q: [0, 0, 0, 1, 0, 0, 0, 1] }] }, root, 'x')
    expect(clip.userData.ik).toEqual({ L: [1, 2, 3, 4, 5, 6], n: undefined })
    expect(clip.tracks.map(t => t.name)).toEqual(['Pelvis_9.quaternion']) // ik 不产生轨道
  })
})

describe('sampleIkAnchor 官方落地锚采样', () => {
  const locoJson = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))
  it('线性插值：段内按 t 比例混合相邻帧；首尾钳制；无数据 null', () => {
    const ik = { L: [0, 0, 0, 1, 0, 0] } // 2 帧
    const out = { set(x, y, z) { this.x = x; this.y = y; this.z = z; return this } }
    expect(sampleIkAnchor(ik, 0.6, 2, 0.3, 'L', out)).toBe(out)
    expect(out.x).toBeCloseTo(0.5, 9)
    sampleIkAnchor(ik, 0.6, 2, -1, 'L', out); expect(out.x).toBe(0)   // 首钳制
    sampleIkAnchor(ik, 0.6, 2, 9, 'L', out); expect(out.x).toBe(1)    // 尾钳制
    expect(sampleIkAnchor({}, 0.6, 2, 0, 'L', out)).toBeNull()
    expect(sampleIkAnchor({ L: [1, 2] }, 0.6, 2, 0, 'L', out)).toBeNull() // 数据不齐
  })

  it('locomotion.json 官方锚的落地性：跑步支撑窗内锚世界漂移 <0.15m（锁 TP_Core 数据质量）', () => {
    const c = locoJson.core.runN
    const STEP = 1.55, rate = (2 * STEP) / c.duration // 锁相世界推进速率
    for (const side of ['L', 'R']) {
      const anchors = []
      for (let f = 0; f < c.n; f++) {
        anchors.push(rate * (f / (c.n - 1)) * c.duration + c.ik[side][f * 3]) // 世界 x
      }
      // 最优连续 1/3 周期窗（≈支撑期长）内最小漂移：官方曲线必须提供一段
      // 世界系可落地窗（锚随盆骨后退 ≈ 体速互相抵消）。支撑窗可跨循环边界——
      // 补一段 +周期位移的环绕副本
      const win = Math.floor(c.n / 3)
      const ext = anchors.concat(anchors.map(a => a + rate * c.duration))
      let best = Infinity
      for (let i = 0; i + win <= ext.length; i++) {
        const seg = ext.slice(i, i + win)
        best = Math.min(best, Math.max(...seg) - Math.min(...seg))
      }
      expect(best).toBeLessThan(0.15)
    }
  })

  it('psa IK 目标骨命名与脚反号：L 目标的侧偏为正、R 为负（换侧采样的依据）', () => {
    for (const key of ['runN', 'walkN']) {
      const c = locoJson.core[key]
      const mid = 3 * Math.floor(c.n / 2)
      expect(c.ik.L[mid + 1]).toBeGreaterThan(0)  // L 目标 Y（侧偏）>0
      expect(c.ik.R[mid + 1]).toBeLessThan(0)
    }
  })
})

describe('pickDeathSide / pickTurnClip 死亡倒向与转身选型', () => {
  it('玩家在正面（dot>0，弹道向后打）→ 背摔；背面/侧后 → 前扑', () => {
    expect(pickDeathSide(1)).toBe('back')
    expect(pickDeathSide(0.01)).toBe('back')
    expect(pickDeathSide(0)).toBe('front')
    expect(pickDeathSide(-0.7)).toBe('front')
  })

  it('转身选型：正角=左转 W / 负角=右转 E，角度取最近档，<20° 不出步', () => {
    expect(pickTurnClip(0.5)).toBe('W45')    // +28.6° 左转 45 档
    expect(pickTurnClip(-0.5)).toBe('E45')
    expect(pickTurnClip(1.0)).toBe('W45')    // 57° 仍属 45 档
    expect(pickTurnClip(1.8)).toBe('W90')    // 103° → 90
    expect(pickTurnClip(-2.4)).toBe('E135')  // -137° → 135
    expect(pickTurnClip(-3.1)).toBe('E180')  // -178° → 180
    expect(pickTurnClip(3.1)).toBe('W180')
    expect(pickTurnClip(0.2)).toBeNull()     // 11°：不出转身踏步（走急停支架）
    expect(pickTurnClip(-0.34)).toBeNull()
    expect(pickTurnClip(0.36)).toBe('W45')
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

describe('turn 8 向集与 stopAdd 支架（TP_Core 停步挑战）', () => {
  const locoJson = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))
  it('crouch 蹲走集：walkE/W 0.933s 蹲高根骨在；蹲走步幅/速度常数锁值', () => {
    expect(locoJson.crouch.walkE.duration).toBeCloseTo(0.9333, 3)
    expect(locoJson.crouch.walkW.duration).toBeCloseTo(0.9333, 3)
    for (const c of [locoJson.crouch.walkE, locoJson.crouch.walkW]) {
      const bones = c.tracks.map(t => t.b)
      expect(bones).toContain('Splitter')
      expect(bones).toContain('L_Knee')
    }
    expect(CROUCH_WALK_SPEED).toBeCloseTo(2.7, 6) // 本体口径 = 50% 跑速
    // 步幅按移速派生（任意速度近零滑步）：2.7 → 1.26；1.76（clip 天然速率）→ 0.82
    expect(crouchWalkStepFor(2.7)).toBeCloseTo(1.26, 3)
    expect(crouchWalkStepFor(1.76)).toBeCloseTo(0.82, 2)
  })

  it('jump 三段集：JumpN 3.23s / JumpLand 0.667s / Falling 滞空循环 2.567s', () => {
    expect(locoJson.jump.jumpN.duration).toBeCloseTo(3.2333, 3)
    expect(locoJson.jump.jumpLand.duration).toBeCloseTo(0.6667, 3)
    expect(locoJson.jump.fall.duration).toBeCloseTo(2.5667, 3)
    for (const c of Object.values(locoJson.jump)) {
      expect(c.tracks.map(t => t.b)).toContain('Splitter')
      expect(c.tracks.map(t => t.b)).toContain('L_Knee')
    }
  })

  it('结构锁值：官方时长（转身 1s / 支架 0.667s）、根骨轨道、stopAdd 含上身支架骨', () => {
    expect(Object.keys(locoJson.turn).sort()).toEqual(['E135','E180','E45','E90','W135','W180','W45','W90'])
    for (const c of Object.values(locoJson.turn)) {
      expect(c.duration).toBeCloseTo(1, 3)
      expect(c.n).toBe(31)
      expect(c.tracks.map(t => t.b)).toContain('Splitter')
    }
    expect(locoJson.stopAdd.duration).toBeCloseTo(0.6667, 3)
    const bones = locoJson.stopAdd.tracks.map(t => t.b)
    expect(bones).toContain('Spine1')
    expect(bones).toContain('Neck')
  })

  it('运行时：turn 8 动作齐备、stopAdd 转加法混合（叠在 kamae 上不替换）', () => {
    const root = fakeHeroSkeleton([['Pelvis', '9'], ['L_Hip', '9'], ['L_Knee', '9'], ['L_Foot', '9'], ['L_Toe', '9'], ['R_Hip', '9'], ['R_Knee', '9'], ['R_Foot', '9'], ['R_Toe', '9'], ['Splitter', '9'], ['Spine1', '9'], ['Neck', '9']])
    const built = buildLocomotion(locoJson, 'jett', root)
    expect(Object.keys(built.turn).sort()).toEqual(['E135','E180','E45','E90','W135','W180','W45','W90'])
    expect(built.turn.E90.duration).toBeCloseTo(1, 3)
    expect(built.stopAdd.blendMode).toBe(THREE.AdditiveAnimationBlendMode)
  })
})
