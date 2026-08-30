import * as THREE from 'three'
import { Tex } from './Textures.js'
import { vary } from '../core/Rng.js'

// 特效系统 v2：曳光 / 贴图弹孔 / 枪口焰+动态点光 / 命中火花 / 击杀爆发+冲击波环 /
// 烟尘 / 抛壳（全部预分配池化，运行时零对象创建；粒子用单张 Points 自定义着色器绘制。
// 视觉扰动量取自 Rng.js 的可复现 PRNG（vary）—— 特效噪声无需加密熵，且便于调试复现）
const MAX_TRACERS = 32
const MAX_DECALS = 128
const MAX_SPARKS = 400
const MAX_PUFFS = 96
const MAX_SHELLS = 22
const MAX_RINGS = 6

// GPU 粒子材质：逐粒子 size/alpha/color 属性
function particleMaterial(tex, blending) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      uScale: { value: 400 }, // 按渲染高度校准（calibrate）
    },
    vertexShader: /* glsl */`
      attribute float asize;
      attribute float aalpha;
      attribute vec3 acolor;
      varying float vA;
      varying vec3 vC;
      uniform float uScale;
      void main() {
        vA = aalpha; vC = acolor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(asize * uScale / max(0.1, -mv.z), 220.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      varying float vA;
      varying vec3 vC;
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        float a = t.a * vA;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vC * t.rgb, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending,
  })
}

// CPU 池化粒子系统：swap-remove 紧凑数组 + BufferAttribute 直写
class ParticleSys {
  constructor(scene, tex, blending, max) {
    this.max = max
    this.n = 0
    const geo = this.geo = new THREE.BufferGeometry()
    this.pos = new Float32Array(max * 3)
    this.col = new Float32Array(max * 3)
    this.size = new Float32Array(max)
    this.alp = new Float32Array(max)
    // CPU 侧动态数据
    this.vel = new Float32Array(max * 3)
    this.life = new Float32Array(max)
    this.maxLife = new Float32Array(max)
    this.size0 = new Float32Array(max)  // 出生尺寸
    this.size1 = new Float32Array(max)  // 末期尺寸
    this.alpha0 = new Float32Array(max)
    this.grav = new Float32Array(max)
    this.drag = new Float32Array(max)
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('acolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('asize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aalpha', new THREE.BufferAttribute(this.alp, 1).setUsage(THREE.DynamicDrawUsage))
    this.points = new THREE.Points(geo, particleMaterial(tex, blending))
    this.points.frustumCulled = false
    this.points.renderOrder = 5
    scene.add(this.points)
  }

  emit(x, y, z, vx, vy, vz, { life = 0.5, size = 0.06, sizeEnd = null, r = 1, g = 1, b = 1, alpha = 1, grav = 0, drag = 0 }) {
    if (this.n >= this.max) return
    const i = this.n++
    const i3 = i * 3
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b
    this.life[i] = life; this.maxLife[i] = life
    this.size[i] = size; this.size0[i] = size
    this.size1[i] = sizeEnd ?? size
    this.alp[i] = alpha; this.alpha0[i] = alpha
    this.grav[i] = grav; this.drag[i] = drag
  }

  _recycle(i) { // 用末尾元素覆盖被删粒子
    const j = --this.n
    if (i !== j) {
      this.pos.copyWithin(i * 3, j * 3, j * 3 + 3)
      this.vel.copyWithin(i * 3, j * 3, j * 3 + 3)
      this.col.copyWithin(i * 3, j * 3, j * 3 + 3)
      this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]
      this.size[i] = this.size[j]; this.size0[i] = this.size0[j]; this.size1[i] = this.size1[j]
      this.alp[i] = this.alp[j]; this.alpha0[i] = this.alpha0[j]
      this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j]
    }
  }

  update(dt) {
    for (let i = 0; i < this.n; i++) {
      const life = this.life[i] - dt
      if (life <= 0) { this._recycle(i); i--; continue }
      this.life[i] = life
      const i3 = i * 3
      const dragK = Math.max(0, 1 - this.drag[i] * dt)
      this.vel[i3] *= dragK
      this.vel[i3 + 1] = this.vel[i3 + 1] * dragK - this.grav[i] * dt
      this.vel[i3 + 2] *= dragK
      this.pos[i3] += this.vel[i3] * dt
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt
      const t = life / this.maxLife[i]              // 1 → 0
      this.alp[i] = this.alpha0[i] * Math.min(1, (1 - t) * 8) * t // 快速淡入 + 线性淡出
      this.size[i] = this.size1[i] + (this.size0[i] - this.size1[i]) * t
    }
    for (const name of ['position', 'acolor', 'asize', 'aalpha']) {
      this.geo.attributes[name].needsUpdate = true
    }
    this.geo.setDrawRange(0, this.n)
  }

  setViewportScale(h, fovDeg) {
    this.points.material.uniforms.uScale.value = h * 0.5 / Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5)
  }
}

export class FX {
  constructor(scene, camera) {
    this.scene = scene
    this.camera = camera

    // 曳光：细长加法混合的拉伸盒（几何体沿 +Z 延伸，配合 lookAt 使 +Z 指向目标）
    const tGeo = new THREE.BoxGeometry(0.014, 0.014, 1)
    tGeo.translate(0, 0, 0.5)
    const tMat = new THREE.MeshBasicMaterial({ color: 0xffdf9e, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
    this.tracers = []
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(tGeo, tMat.clone())
      m.visible = false
      m.matrixAutoUpdate = false
      scene.add(m)
      this.tracers.push({ mesh: m, life: 0 })
    }
    this.tracerIdx = 0

    // 弹孔：程序化弹孔贴图（灼烧边 + 裂纹 + 翻边高光）
    const dGeo = new THREE.CircleGeometry(0.05, 12)
    const dMat = new THREE.MeshBasicMaterial({ map: Tex.hole(), transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
    this.decals = []
    for (let i = 0; i < MAX_DECALS; i++) {
      const m = new THREE.Mesh(dGeo, dMat.clone())
      m.visible = false
      m.matrixAutoUpdate = false
      scene.add(m)
      this.decals.push({ mesh: m, life: 0 })
    }
    this.decalIdx = 0

    // 枪口焰：星形贴图加法精灵（挂相机）+ 世界空间动态点光
    const fMat = new THREE.SpriteMaterial({ map: Tex.flash(), color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    this.flash = new THREE.Sprite(fMat)
    this.flash.scale.set(0.3, 0.3, 1)
    this.flash.visible = false
    this.flashLife = 0
    this.flashLight = new THREE.PointLight(0xffbe7a, 0, 11, 2)
    this.flashLight.castShadow = false
    scene.add(this.flashLight)
    this.lightLife = 0
    this.lightPeak = 0
    this.lightDur = 0.06

    // 粒子：火花（加法）+ 烟尘（普通混合）
    this.sparks = new ParticleSys(scene, Tex.spark(), THREE.AdditiveBlending, MAX_SPARKS)
    this.puffs = new ParticleSys(scene, Tex.smoke(), THREE.NormalBlending, MAX_PUFFS)

    // 抛壳：黄铜小盒，带重力/落地反弹/自旋
    const sGeo = new THREE.BoxGeometry(0.011, 0.011, 0.027)
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24b, metalness: 0.9, roughness: 0.32 })
    this.shells = []
    for (let i = 0; i < MAX_SHELLS; i++) {
      const m = new THREE.Mesh(sGeo, brass)
      m.visible = false
      scene.add(m)
      this.shells.push({ mesh: m, vel: new THREE.Vector3(), ang: new THREE.Vector3(), life: 0 })
    }
    this.shellIdx = 0

    // 冲击波环（击杀反馈）：加法精灵，膨胀 + 淡出
    this.rings = []
    for (let i = 0; i < MAX_RINGS; i++) {
      const mat = new THREE.SpriteMaterial({ map: Tex.ring(), color: 0xffb347, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
      const s = new THREE.Sprite(mat)
      s.visible = false
      scene.add(s)
      this.rings.push({ mesh: s, life: 0, dur: 0.35, maxScale: 1.6 })
    }
    this.ringIdx = 0
  }

  attachFlash(camera, offset) {
    this.flash.position.copy(offset)
    camera.add(this.flash)
  }

  // 每帧校准粒子尺寸（窗口/FOV 变化时调用；不调只影响点大小尺度）
  calibrate(width, height, fovDeg) {
    this.sparks.setViewportScale(height, fovDeg)
    this.puffs.setViewportScale(height, fovDeg)
  }

  tracer(from, to) {
    const t = this.tracers[this.tracerIdx]
    this.tracerIdx = (this.tracerIdx + 1) % MAX_TRACERS
    const m = t.mesh
    m.position.copy(from)
    m.lookAt(to)
    const dist = from.distanceTo(to)
    m.scale.set(1, 1, Math.max(dist, 0.1))
    m.visible = true
    m.updateMatrix()
    m.material.opacity = 0.85
    m.material.color.setHSL(0.11 + vary() * 0.02, 0.92, 0.72) // 暖黄微扰动
    t.life = 0.07
  }

  decal(x, y, z, nx, ny, nz) {
    const d = this.decals[this.decalIdx]
    this.decalIdx = (this.decalIdx + 1) % MAX_DECALS
    const m = d.mesh
    m.position.set(x + nx * 0.005, y + ny * 0.005, z + nz * 0.005)
    _dq.setFromUnitVectors(_fwd, _n.set(nx, ny, nz))
    m.quaternion.copy(_dq)
    m.rotateZ(vary() * Math.PI * 2) // 随机滚转让弹孔不重样
    m.scale.setScalar(0.75 + vary() * 0.6)
    m.visible = true
    m.updateMatrix()
    m.material.opacity = 0.95
    d.life = 14
  }

  muzzle(worldPos) {
    this.flash.visible = true
    this.flash.material.opacity = 0.9
    this.flash.material.rotation = vary() * Math.PI * 2
    const s = 0.26 + vary() * 0.14
    this.flash.scale.set(s, s, 1)
    this.flashLife = 0.045
    if (worldPos) {
      this.flashLight.position.copy(worldPos)
      this.flashLight.color.setHex(0xffbe7a)
      this.lightPeak = 16
      this.lightDur = 0.06
      this.lightLife = this.lightDur
    }
  }

  // 墙面/硬表面命中：碎屑火花 + 尘雾
  impact(x, y, z, nx, ny, nz) {
    for (let i = 0; i < 8; i++) {
      const sp = 1.2 + vary() * 2.6
      _v.set(nx + (vary() - 0.5) * 1.4, ny + vary() * 1.1, nz + (vary() - 0.5) * 1.4).normalize().multiplyScalar(sp)
      this.sparks.emit(x, y, z, _v.x, _v.y, _v.z, {
        life: 0.16 + vary() * 0.22, size: 0.022 + vary() * 0.02,
        r: 1, g: 0.82 + vary() * 0.15, b: 0.55, grav: 6, drag: 1.5,
      })
    }
    this.puffs.emit(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03,
      nx * 0.3, 0.35, nz * 0.3,
      { life: 0.5 + vary() * 0.25, size: 0.1, sizeEnd: 0.34, r: 0.62, g: 0.58, b: 0.52, alpha: 0.34, drag: 1.6 })
  }

  // 命中机器人：火花迸溅（爆头更密 + 泛红 + 白闪芯）
  hitBurst(point, head) {
    const p = point ?? { x: 0, y: 1.3, z: 0 }
    const n = head ? 18 : 11
    for (let i = 0; i < n; i++) {
      _v.set(vary() - 0.5, vary() * 0.9, vary() - 0.5).normalize()
        .multiplyScalar(1.4 + vary() * 3.2)
      const warm = vary()
      this.sparks.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, {
        life: 0.18 + vary() * 0.3, size: 0.024 + vary() * 0.026,
        r: 1, g: head ? 0.5 + warm * 0.3 : 0.75 + warm * 0.2, b: head ? 0.35 : 0.45, grav: 6.5, drag: 1.8,
      })
    }
    if (head) {
      for (let i = 0; i < 6; i++) {
        _v.set(vary() - 0.5, vary() - 0.5, vary() - 0.5).normalize().multiplyScalar(0.8 + vary() * 1.6)
        this.sparks.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, {
          life: 0.12 + vary() * 0.1, size: 0.06, r: 1, g: 1, b: 0.95, drag: 3,
        })
      }
    }
    this.puffs.emit(p.x, p.y, p.z, 0, 0.4, 0, { life: 0.45, size: 0.09, sizeEnd: 0.3, r: 0.66, g: 0.6, b: 0.55, alpha: 0.3, drag: 1.8 })
  }

  // 击杀：大爆发 + 膨胀冲击波环 + 光脉冲（机器人 = 电火花过载 + 上升烟柱）
  killBurst(point, head) {
    const p = point ?? { x: 0, y: 1.3, z: 0 }
    const n = head ? 44 : 30
    for (let i = 0; i < n; i++) {
      _v.set(vary() - 0.5, vary() * 1.1 - 0.15, vary() - 0.5).normalize()
        .multiplyScalar(2 + vary() * 4.6)
      const warm = vary()
      this.sparks.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, {
        life: 0.26 + vary() * 0.5, size: 0.026 + vary() * 0.03,
        r: 1, g: head ? 0.42 + warm * 0.35 : 0.6 + warm * 0.3, b: head ? 0.3 : 0.35, grav: 7, drag: 1.6,
      })
    }
    for (let i = 0; i < 6; i++) {
      this.puffs.emit(
        p.x + (vary() - 0.5) * 0.24, p.y + vary() * 0.3, p.z + (vary() - 0.5) * 0.24,
        (vary() - 0.5) * 0.3, 0.7 + vary() * 0.7, (vary() - 0.5) * 0.3,
        { life: 0.55 + vary() * 0.4, size: 0.12, sizeEnd: 0.5, r: 0.5, g: 0.47, b: 0.44, alpha: 0.4, drag: 1.2 })
    }
    // 冲击波环（爆头红 / 击杀琥珀）
    const r = this.rings[this.ringIdx]
    this.ringIdx = (this.ringIdx + 1) % MAX_RINGS
    r.mesh.position.set(p.x, p.y, p.z)
    r.mesh.material.color.setHex(head ? 0xff4655 : 0xffb347)
    r.mesh.material.opacity = 0.85
    r.mesh.scale.setScalar(0.2)
    r.mesh.visible = true
    r.life = r.dur = head ? 0.42 : 0.34
    r.maxScale = head ? 2.0 : 1.5
    // 光脉冲
    this.flashLight.position.set(p.x, p.y + 0.2, p.z)
    this.flashLight.color.setHex(head ? 0xff6a55 : 0xffa050)
    this.lightPeak = head ? 26 : 18
    this.lightDur = 0.16
    this.lightLife = this.lightDur
  }

  // 抛壳（世界坐标抛壳口）
  shell(worldPos) {
    const s = this.shells[this.shellIdx]
    this.shellIdx = (this.shellIdx + 1) % MAX_SHELLS
    const m = s.mesh
    m.position.copy(worldPos)
    // 相机右上后方抛出
    _v.setFromMatrixColumn(this.camera.matrixWorld, 0) // right
    s.vel.copy(_v).multiplyScalar(1.4 + vary() * 0.8)
    _v.setFromMatrixColumn(this.camera.matrixWorld, 1) // up
    s.vel.addScaledVector(_v, 1.7 + vary() * 0.8)
    _v.setFromMatrixColumn(this.camera.matrixWorld, 2) // back(+Z)
    s.vel.addScaledVector(_v, 0.4 + vary() * 0.4)
    s.ang.set(vary() * 14 - 7, vary() * 14 - 7, vary() * 14 - 7)
    s.life = 1.5
    m.rotation.set(vary() * 3, vary() * 3, vary() * 3)
    m.visible = true
  }

  update(dt) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue
      t.life -= dt
      t.mesh.material.opacity = Math.max(0, t.life / 0.07) * 0.85
      if (t.life <= 0) t.mesh.visible = false
    }
    for (const d of this.decals) {
      if (d.life <= 0) continue
      d.life -= dt
      if (d.life < 3) d.mesh.material.opacity = Math.max(0, d.life / 3) * 0.95
      if (d.life <= 0) d.mesh.visible = false
    }
    if (this.flashLife > 0) {
      this.flashLife -= dt
      this.flash.material.opacity = Math.max(0, this.flashLife / 0.045) * 0.9
      if (this.flashLife <= 0) this.flash.visible = false
    }
    // 动态光衰减
    if (this.lightLife > 0) {
      this.lightLife -= dt
      this.flashLight.intensity = this.lightPeak * Math.max(0, this.lightLife / this.lightDur)
    } else if (this.flashLight.intensity !== 0) {
      this.flashLight.intensity = 0
    }
    this.sparks.update(dt)
    this.puffs.update(dt)
    // 抛壳物理
    for (const s of this.shells) {
      if (s.life <= 0) continue
      s.life -= dt
      if (s.life <= 0) { s.mesh.visible = false; continue }
      s.vel.y -= 13 * dt
      s.mesh.position.addScaledVector(s.vel, dt)
      if (s.mesh.position.y < 0.012 && s.vel.y < 0) { // 落地弹跳
        s.mesh.position.y = 0.012
        s.vel.y *= -0.32
        s.vel.x *= 0.72; s.vel.z *= 0.72
        s.ang.multiplyScalar(0.5)
        if (Math.abs(s.vel.y) < 0.5) s.vel.y = 0
      }
      s.mesh.rotation.x += s.ang.x * dt
      s.mesh.rotation.y += s.ang.y * dt
      s.mesh.rotation.z += s.ang.z * dt
    }
    // 冲击波环
    for (const r of this.rings) {
      if (r.life <= 0) continue
      r.life -= dt
      const t = Math.max(0, r.life / r.dur)
      const e = 1 - t * t * t // ease-out 膨胀
      r.mesh.scale.setScalar(0.2 + (r.maxScale - 0.2) * e)
      r.mesh.material.opacity = t * 0.85
      if (r.life <= 0) r.mesh.visible = false
    }
  }
}

const _dq = new THREE.Quaternion()
const _fwd = new THREE.Vector3(0, 0, 1)
const _n = new THREE.Vector3()
const _v = new THREE.Vector3()
