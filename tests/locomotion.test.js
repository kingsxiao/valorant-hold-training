// Locomotion：官方 .psa 曲线（locomotion.json）→ AnimationClip 的构建与
// 走/跑/横移权重分配（Bot._setAnimWeights 共用的纯函数）
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import fs from 'node:fs'
import { buildClip, buildLocomotion, locoWeights, sampleIkAnchor, pickDeathSide, pickTurnClip, CROUCH_WALK_STEP, CROUCH_WALK_SPEED, jumpFallBlend, JUMP_FALL_AFTER, JUMP_FALL_FADE, locoBodyY, PELVIS_REF_Y, PELVIS_CROUCH_DROP, FOOT_GROUND_Y, gaitStepLen, STEP_WALK, STEP_RUN, STEP_STRAFE_RUN } from '../src/core/Locomotion.js'

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

describe('buildClip psa 根链参考系修正（Splitter/Skeleton 轨道值为 GLB rest 的逆）', () => {
  // 英雄 GLB 同构骨架：Splitter 为运动根，直接子骨 Pelvis/Spine1，孙骨 L_Hip
  function heroSkeleton() {
    const root = new THREE.Object3D()
    root.name = 'mesh'
    const mk = (name, parent, q) => {
      const b = new THREE.Bone()
      b.name = name
      if (q) b.quaternion.copy(q)
      parent.add(b)
      return b
    }
    const restQ = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5).normalize()
    const skeleton = mk('Skeleton_00', root, new THREE.Quaternion(0, 0, -Math.SQRT1_2, Math.SQRT1_2))
    const splitter = mk('Splitter_02', skeleton, restQ)
    const pelvis = mk('Pelvis_0147', splitter)
    mk('Spine1_03', splitter)
    mk('L_Hip_0138', pelvis)
    return root
  }

  const ROOT_CLIP = {
    duration: 0.6,
    times: [0, 0.6],
    tracks: [
      // psa Splitter 恒定值 = GLB rest 的逆（(0.5,0.5,0.5,±0.5) 互逆）
      { b: 'Splitter', q: [0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, -0.5], p: [-0.12, 0.05, 1.15, -0.12, 0.05, 1.15] },
      { b: 'Skeleton', q: [0, 0, 0, -1, 0, 0, 0, -1], p: [0, 0, 1.0, 0, 0, 0.9] },
      { b: 'Pelvis', q: [0, 0, 0, 1, 0, 0.1, 0, 0.99] },
      { b: 'L_Hip', q: [0.05, 0, 0, 1, 0.05, 0, 0, 1] },
    ],
  }

  it('根链骨跳过旋转轨道、位置轨道原样保留（骨盆高度不丢）', () => {
    const root = heroSkeleton()
    const clip = buildClip(ROOT_CLIP, root, 'runN')
    const names = clip.tracks.map(t => t.name)
    expect(names).not.toContain('Splitter_02.quaternion')
    expect(names).not.toContain('Skeleton_00.quaternion')
    const sp = clip.tracks.find(t => t.name === 'Splitter_02.position')
    expect(sp).toBeTruthy()
    // 位置在公共父框架（z-up）里与 GLB 一致，原样保留
    ROOT_CLIP.tracks[0].p.forEach((v, i) => expect(sp.values[i]).toBeCloseTo(v, 6))
  })

  it('非根链骨（含 Splitter 直接子骨）轨道原样保留——无需逐骨换系', () => {
    const root = heroSkeleton()
    const clip = buildClip(ROOT_CLIP, root, 'runN')
    // Pelvis 是 Splitter 直接子骨：psa 局部与 GLB 局部同约定，原样保留
    const pelvis = clip.tracks.find(t => t.name === 'Pelvis_0147.quaternion')
    ROOT_CLIP.tracks[2].q.forEach((v, i) => expect(pelvis.values[i]).toBeCloseTo(v, 6))
    // 孙骨同样原样
    const hip = clip.tracks.find(t => t.name === 'L_Hip_0138.quaternion')
    ROOT_CLIP.tracks[3].q.forEach((v, i) => expect(hip.values[i]).toBeCloseTo(v, 6))
  })

  it('无 Splitter 的骨架（Mixamo XBot 回退）→ 全部原样保留（旧行为）', () => {
    const root = fakeHeroSkeleton([['Pelvis', '0131'], ['L_Hip', '0136']])
    const clip = buildClip(JSON_CLIP, root, 'runN')
    const q = clip.tracks.find(t => t.name === 'L_Hip_0136.quaternion')
    JSON_CLIP.tracks[1].q.forEach((v, i) => expect(q.values[i]).toBeCloseTo(v, 6))
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

  it('psa IK 目标锚与脚同名同侧（167 轮翻转锁死）：L 目标侧偏为正、R 为负', () => {
    for (const key of ['runN', 'walkN']) {
      const c = locoJson.core[key]
      const mid = 3 * Math.floor(c.n / 2)
      expect(c.ik.L[mid + 1]).toBeGreaterThan(0)  // L 目标 Y（侧偏，+Y=左）>0
      expect(c.ik.R[mid + 1]).toBeLessThan(0)
    }
  })

  it('支撑锚同侧可达性（同侧配对的几何依据）：strafe 族支撑锚到同侧髋恒近于对侧', () => {
    // 走/跑 N 族锚侧偏仅 ±0.05~0.13（近中线），两种配对都可达、分辨不出侧别；
    // strafe 族锚侧扫 ±0.5 且交叉脚前伸 0.25~0.30——反号配对让每脚追对侧+交叉
    // 锚，水平距离 0.65+0.30 超出腿长水平预算 sqrt(1.11²−0.775²)≈0.795 → 一脚
    // 整支撑期悬空滑冰（167 轮实测）。本测试锁「同侧髋更近」的数据事实。
    const clips = [
      locoJson.core.runN, locoJson.core.walkN,
      locoJson.strafe.runE, locoJson.strafe.walkE,
      locoJson.strafe.runW, locoJson.strafe.walkW,
    ]
    const HIP = 0.115 // L_Hip 11.522cm（psa↔GLB 分毫不差互证）
    for (const c of clips) {
      for (const side of ['L', 'R']) {
        const hip = side === 'L' ? HIP : -HIP
        let maxIpsi = 0, maxContra = 0
        let zMin = Infinity
        for (let f = 0; f < c.n; f++) zMin = Math.min(zMin, c.ik[side][f * 3 + 2])
        for (let f = 0; f < c.n; f++) {
          if (c.ik[side][f * 3 + 2] > zMin + 0.045) continue // 支撑帧（锚贴地窗）
          const y = c.ik[side][f * 3 + 1]
          maxIpsi = Math.max(maxIpsi, Math.abs(y - hip))
          maxContra = Math.max(maxContra, Math.abs(y + hip))
        }
        expect(maxIpsi).toBeLessThan(maxContra) // 同侧髋更近 = 命名不反号
        expect(maxIpsi).toBeLessThan(0.65)     // 腿长水平预算内（0.795−前伸余量）
      }
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


describe('locoBodyY 身体高度解算（状态混合准静态参考，2026-09-11 抽搐回归修复）', () => {
  it('端点锁值：站定=贴地余量−最低脚高（kamae 双脚落clip 无伪影）；移动=骨盆参考高−骨盆局部高', () => {
    // kamae 实测：双脚落局部高 0.127 → 站定 mesh.y ≈ −0.037；runN 实测骨盆
    // 局部 1.05~1.14 → 移动 mesh.y ≈ −0.2±（骨盆世界 0.85~0.94）
    expect(FOOT_GROUND_Y).toBeCloseTo(0.09, 5)
    expect(PELVIS_REF_Y).toBeCloseTo(0.90, 5)
    expect(locoBodyY({ hipsLocalY: 0.895, loMinY: 0.127, moveW: 0 })).toBeCloseTo(-0.037, 3)
    expect(locoBodyY({ hipsLocalY: 1.10, loMinY: 0.6, moveW: 1 })).toBeCloseTo(-0.20, 3)
  })

  it('moveW 混合连续单调：两参考间线性过渡，无跳变（追逐逐帧脚高的弹跳已根除）', () => {
    const a = locoBodyY({ hipsLocalY: 1.10, loMinY: 0.127, moveW: 0 })
    const mid = locoBodyY({ hipsLocalY: 1.10, loMinY: 0.127, moveW: 0.5 })
    const b = locoBodyY({ hipsLocalY: 1.10, loMinY: 0.127, moveW: 1 })
    expect(mid).toBeCloseTo((a + b) / 2, 6)
    expect(mid).toBeGreaterThan(Math.min(a, b))
    expect(mid).toBeLessThan(Math.max(a, b))
  })

  it('移动态目标与最低脚高无关（跑步机伪影隔离）：loMinY 大幅摆动不动摇移动态高度', () => {
    const y1 = locoBodyY({ hipsLocalY: 1.10, loMinY: 0.45, moveW: 1 })
    const y2 = locoBodyY({ hipsLocalY: 1.10, loMinY: 0.96, moveW: 1 })
    expect(y1).toBe(y2)
  })

  it('蹲族移动态降骨盆参考：crouchW=1 时目标低 0.18（官方蹲姿骨盆 ≈0.72）', () => {
    const stand = locoBodyY({ hipsLocalY: 0.95, loMinY: 0.5, moveW: 1 })
    const crouch = locoBodyY({ hipsLocalY: 0.95, loMinY: 0.5, moveW: 1, crouchW: 1 })
    expect(stand - crouch).toBeCloseTo(PELVIS_CROUCH_DROP, 5)
    // 蹲走实测：hipsLocal 0.947 → 骨盆世界 ≈ 0.72
    expect(crouch).toBeCloseTo(0.90 - 0.18 - 0.95, 5)
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
    expect(CROUCH_WALK_STEP).toBeCloseTo(0.735, 6) // 步幅 = clip 属性（触地窗速率×周期/2），不随移速变
    // 近零滑步口径（160 轮）：脚速 = 移速×(1−触地速率×周期/(2×步幅))，
    // 触地速率≈1.6×0.933/2=0.747 → 2.7 m/s 时 |脚速| < 0.1
    expect(Math.abs(2.7 * (1 - 1.6 * 0.9333 / (2 * 0.735)))).toBeLessThan(0.1)
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

describe('gaitStepLen 官方步距相位锁（160 轮：各族天然速度不同）', () => {
  it('各族步距常量：走/横移走 1.05、跑 1.54、横移跑 1.40', () => {
    expect(STEP_WALK).toBeCloseTo(1.05, 6)
    expect(STEP_RUN).toBeCloseTo(1.54, 6)
    expect(STEP_STRAFE_RUN).toBeCloseTo(1.40, 6)
  })

  it('runW/strafeW 连续内插：换态步距无跳变（相位速率连续）', () => {
    expect(gaitStepLen({})).toBeCloseTo(STEP_WALK, 6)
    expect(gaitStepLen({ runW: 1 })).toBeCloseTo(STEP_RUN, 6)
    expect(gaitStepLen({ strafeW: 1 })).toBeCloseTo(STEP_WALK, 6) // 横移走 = 走步距
    expect(gaitStepLen({ runW: 1, strafeW: 1 })).toBeCloseTo(STEP_STRAFE_RUN, 6)
    expect(gaitStepLen({ runW: 0.5 })).toBeCloseTo((STEP_WALK + STEP_RUN) / 2, 6)
    // 域外钳制
    expect(gaitStepLen({ runW: 9 })).toBeCloseTo(gaitStepLen({ runW: 1 }), 6)
    expect(gaitStepLen({ runW: -1 })).toBeCloseTo(STEP_WALK, 6)
  })

  it('官方锚触地窗互证：runN 步距 ≈ STEP_RUN、runE/runW ≈ STEP_STRAFE_RUN、walkN ≈ STEP_WALK（±0.12）', () => {
    // 触地窗（z ≤ zMin+4mm 的环形最长段）后扫速率 × 周期 / 2 = 跑族步距（有腾空相）
    const stepOf = (c, axis) => {
      const rates = []
      for (const side of ['L', 'R']) {
        let zmin = 9
        for (let f = 0; f < c.n; f++) zmin = Math.min(zmin, c.ik[side][f * 3 + 2])
        const flat = []
        for (let f = 0; f < c.n; f++) if (c.ik[side][f * 3 + 2] <= zmin + 0.004) flat.push(f)
        if (flat.length < 2) continue
        let gaps = []
        for (let i = 1; i < flat.length; i++) gaps.push(flat[i] - flat[i - 1])
        const maxGap = gaps.length ? Math.max(...gaps) : 0
        let seg = flat
        if (maxGap > 1) {
          const gi = gaps.indexOf(maxGap)
          seg = flat.slice(gi + 1).concat(flat.slice(0, gi + 1).map(v => v + c.n))
        }
        if (seg.length < 2) continue
        const f0 = seg[0], f1 = seg[seg.length - 1]
        const p0 = c.ik[side][(f0 % c.n) * 3 + axis], p1 = c.ik[side][(f1 % c.n) * 3 + axis]
        const t0 = f0 / (c.n - 1) * c.duration, t1 = f1 / (c.n - 1) * c.duration
        rates.push(Math.abs(p1 - p0) / (t1 - t0))
      }
      const v = rates.reduce((a, b) => a + b, 0) / Math.max(1, rates.length)
      return v * c.duration / 2
    }
    const core = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8')).core
    expect(Math.abs(stepOf(core.runN, 0) - STEP_RUN)).toBeLessThan(0.12)
    expect(Math.abs(stepOf(core.runE, 1) - STEP_STRAFE_RUN)).toBeLessThan(0.12)
    expect(Math.abs(stepOf(core.runW, 1) - STEP_STRAFE_RUN)).toBeLessThan(0.12)
    expect(Math.abs(stepOf(core.walkN, 0) - STEP_WALK)).toBeLessThan(0.12)
  })

  it('整身 clip 的官方锚导出：turn 锚是真实踏步曲线、stopAdd 锚退化在原点（不入锚源）', () => {
    const j = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))
    const t = j.turn.E90.ik
    expect(t.L.length).toBeGreaterThanOrEqual(j.turn.E90.n * 3)
    // 转身锚 z 在踝高带（0.12~0.21）且中段有位移（真实踏步）
    const zs = t.L.filter((_, i) => i % 3 === 2)
    expect(Math.max(...zs)).toBeLessThan(0.21)
    expect(Math.min(...zs)).toBeGreaterThan(0.11)
    const xs = t.L.filter((_, i) => i % 3 === 0)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.1)
    // stopAdd 的 IK 目标恒在原点附近（支架冻结双脚，锚不可用 → 锚源不含 stopAdd）
    const sa = j.stopAdd.ik.L
    expect(Math.hypot(...sa.slice(0, 3))).toBeLessThan(0.01)
  })
})

describe('jumpFallBlend 滞空换层混合比', () => {
  it('FALL_AFTER 起淡入、+FADE 完成（smoothstep），域外钳制', () => {
    expect(jumpFallBlend(0)).toBe(0)
    expect(jumpFallBlend(JUMP_FALL_AFTER)).toBe(0)
    const mid = jumpFallBlend(JUMP_FALL_AFTER + JUMP_FALL_FADE / 2)
    expect(mid).toBeGreaterThan(0.45)
    expect(mid).toBeLessThan(0.55)
    expect(jumpFallBlend(JUMP_FALL_AFTER + JUMP_FALL_FADE)).toBe(1)
    expect(jumpFallBlend(JUMP_FALL_AFTER + 10)).toBe(1)
  })
  it('常数口径：淡入起点 0.35s（蹬伸 0.15 + 0.2 空中）、淡入窗 0.18s', () => {
    expect(JUMP_FALL_AFTER).toBeCloseTo(0.35, 3)
    expect(JUMP_FALL_FADE).toBeCloseTo(0.18, 3)
  })
})
