import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { worldToListener, AudioSys } from '../src/core/Audio.js'

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

// 声画同步提前量：声音到扬声器还需 outputLatency，画面下个 vsync（~半帧 8ms）
// 就出现 → 全部调度点提前 (延迟 − 8ms)，下限 0。数值锚定 2026-09-07 浏览器
// 实测（Chrome outputLatency 8ms→0 / 模拟 30ms→22ms）。
describe('_syncLead（WebAudio 输出延迟补偿）', () => {
  const makeSys = (latency, t = 1) => {
    const a = new AudioSys()
    // 只注入 _syncLead 依赖的最小 ctx（不发真音频）
    a.ctx = { currentTime: t, outputLatency: latency }
    return a
  }

  it('30ms 输出延迟 → 提前 22ms（延迟 − 半帧）', () => {
    expect(makeSys(0.03)._syncLead()).toBeCloseTo(0.022, 6)
  })

  it('低延迟设备（≤8ms）不抢拍：提前量取 0', () => {
    expect(makeSys(0.008)._syncLead()).toBe(0)
    expect(makeSys(0)._syncLead()).toBe(0)
  })

  it('异常大的延迟值钳制在 80ms', () => {
    expect(makeSys(0.5)._syncLead()).toBeCloseTo(0.08, 6)
  })

  it('缓存：1s 内不重算，之后随缓冲变化刷新', () => {
    const a = makeSys(0.03, 1)
    expect(a._syncLead()).toBeCloseTo(0.022, 6)
    a.ctx.outputLatency = 0.012
    a.ctx.currentTime = 1.5 // 不足 1s：沿用缓存
    expect(a._syncLead()).toBeCloseTo(0.022, 6)
    a.ctx.currentTime = 2.1 // 超过 1s：重算
    expect(a._syncLead()).toBeCloseTo(0.004, 6)
  })

  it('无 outputLatency 时回退 baseLatency', () => {
    const a = new AudioSys()
    a.ctx = { currentTime: 1, baseLatency: 0.02 }
    expect(a._syncLead()).toBeCloseTo(0.012, 6)
  })
})

// 音量滑杆 → 主增益的感知补偿（幂律 0.62）：小音量端弱信号（脚步/落点）
// 不被压进听阈以下，满音量端点不变。锚定：0.1 → 0.24、0.5 → 0.65、1 → 1。
describe('setVolume（低音量感知补偿曲线）', () => {
  const gainOf = (v) => {
    const a = new AudioSys()
    a.master = { gain: { value: 0 } }
    a.setVolume(v)
    return a.master.gain.value
  }

  it('幂律 0.62：0.1 → ~0.24（线性只有 0.1，弱信号得以保留）', () => {
    expect(gainOf(0.1)).toBeCloseTo(0.24, 2)
  })

  it('中段 0.5 → ~0.65', () => {
    expect(gainOf(0.5)).toBeCloseTo(0.65, 2)
  })

  it('端点：0 → 0，1 → 1（满音量不变）', () => {
    expect(gainOf(0)).toBe(0)
    expect(gainOf(1)).toBeCloseTo(1, 6)
  })

  it('单调性：补偿曲线随滑杆单调递增（0.2 < 0.5 < 0.8）', () => {
    expect(gainOf(0.2)).toBeLessThan(gainOf(0.5))
    expect(gainOf(0.5)).toBeLessThan(gainOf(0.8))
  })
})

// 用户替换音效的响度归一（_userGain）：自有录音电平参差，按 RMS 归一到
// 合成基准 0.18、±12dB（×0.25/×4）限幅。锚定：基准录音→1、过响→压、
// 过轻→抬、极端值钳制、静音/异常不产生增益。
describe('_userGain（用户音效响度归一）', () => {
  const stub = (rms) => {
    // 构造 1 秒、RMS≈rms 的单声道伪 buffer（方波 RMS=振幅，精确可控）
    const n = 44100
    const d = new Float32Array(n)
    for (let i = 0; i < n; i++) d[i] = ((i % 2) ? rms : -rms)
    return { getChannelData: () => d, length: n }
  }
  const a = new AudioSys()

  it('基准电平（RMS 0.18）→ 增益 ≈1', () => {
    expect(a._userGain(stub(0.18))).toBeCloseTo(1, 1)
  })

  it('过响录音（RMS 0.72，+12dB）→ 压到 ×0.25', () => {
    expect(a._userGain(stub(0.72))).toBeCloseTo(0.25, 2)
  })

  it('过轻录音（RMS 0.02）→ 抬到 ×4 封顶（理论 9）', () => {
    expect(a._userGain(stub(0.02))).toBe(4)
  })

  it('中等偏轻（RMS 0.09）→ ×2 线性区内', () => {
    expect(a._userGain(stub(0.09))).toBeCloseTo(2, 1)
  })

  it('静音/异常 → 不施加增益（返回 1）', () => {
    expect(a._userGain(stub(0))).toBe(1)
    expect(a._userGain({ getChannelData: () => new Float32Array(16), length: 16 })).toBe(1)
  })
})
