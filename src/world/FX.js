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
const MAX_HELMETS = 6

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
  constructor(scene, camera, engine = null) {
    this.scene = scene
    this.camera = camera
    this.vmFlash = engine?.vmFlashLight ?? null // vmScene 枪口焰点光（见 Engine）

    // 曳光：细长拉伸盒 + 自定义着色器（几何沿 +Z，lookAt 后 +Z 指向目标）。
    // 着色器做两件 MeshBasicMaterial 做不到的事：
    //  1) 沿长度渐变：段头白热、段尾渐暗（真实曳光是拖尾衰减的光带，不是均匀亮棒）
    //  2) 锥形收尾：顶点按 z 收窄束径（尾 40% → 头 100%），头粗尾细
    // 几何 z∈[0,1]（translate 后），z=1 为段头
    const tGeo = new THREE.BoxGeometry(0.014, 0.014, 1)
    tGeo.translate(0, 0, 0.5)
    const tMat = new THREE.ShaderMaterial({
      uniforms: {
        uAlpha: { value: 0.85 },
        uHead: { value: new THREE.Color(0xfff6d8) },
        uTail: { value: new THREE.Color(0xd98a2b) },
        uRush: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying float vZ;
        void main() {
          vZ = position.z;
          vec3 p = position;
          p.x *= mix(0.4, 1.0, position.z); // 锥形：尾细头粗
          p.y *= mix(0.4, 1.0, position.z);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uAlpha;
        uniform vec3 uHead;
        uniform vec3 uTail;
        uniform float uRush;
        varying float vZ;
        void main() {
          // 头部权重：z^1.5——前 30% 长度承载主要亮度，尾部拖一条渐熄余辉。
          // uRush（末段冲刺 0..1）：头色向白热偏移——拉伸+白化+渐隐三效合一
          float h = pow(vZ, 1.5);
          vec3 head = mix(uHead, vec3(1.0), uRush * 0.5);
          vec3 c = mix(uTail, head, h);
          float a = uAlpha * (0.15 + 0.85 * h);
          gl_FragColor = vec4(c * a, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    this.tracers = []
    // 段头飞行光珠 = 内核亮珠 + 外层 halo（双层才有"辉光"读法：亮芯 + 泛光，
    // 阳光直射的亮场景里单层小精灵会被环境光"洗掉"，halo 保住存在感）
    const glowMat = new THREE.SpriteMaterial({ map: Tex.spark(), color: 0xffedb8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    const haloMat = new THREE.SpriteMaterial({ map: Tex.spark(), color: 0xffc97a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(tGeo, tMat.clone())
      m.visible = false
      m.matrixAutoUpdate = false
      m.frustumCulled = false
      scene.add(m)
      const glow = new THREE.Sprite(glowMat.clone())
      glow.visible = false
      glow.scale.setScalar(0.075)
      scene.add(glow)
      const halo = new THREE.Sprite(haloMat.clone())
      halo.visible = false
      halo.scale.setScalar(0.22)
      scene.add(halo)
      // 飞行曳光段状态：from/to（钳制后起终点）、dist/dur（全程距离/时间）、
      // seg（段长 m）、width（束径倍率）——update 里沿弹道推短光段
      this.tracers.push({
        mesh: m, glow, halo, life: 0, baseOp: 0.85, width: 1,
        from: new THREE.Vector3(), to: new THREE.Vector3(),
        dist: 1, dur: 0.07, seg: 5,
      })
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

    // 枪口焰：星形贴图加法精灵（世界坐标，跟 viewmodel 实测枪口）+ 动态点光
    const fMat = new THREE.SpriteMaterial({ map: Tex.flash(), color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    this.flash = new THREE.Sprite(fMat)
    this.flash.scale.set(0.3, 0.3, 1)
    this.flash.visible = false
    scene.add(this.flash)
    this.flashLife = 0
    this.flashBase = 0.9 // 当前焰基准不透明度（消音武器压低；update 按比例衰减）
    this.flashLight = new THREE.PointLight(0xffbe7a, 0, 11, 2)
    this.flashLight.castShadow = false
    scene.add(this.flashLight)
    this.lightLife = 0
    this.lightPeak = 0
    this.lightDur = 0.06

    // 粒子：火花（加法）+ 烟尘（普通混合）
    this.sparks = new ParticleSys(scene, Tex.spark(), THREE.AdditiveBlending, MAX_SPARKS)
    this.puffs = new ParticleSys(scene, Tex.smoke(), THREE.NormalBlending, MAX_PUFFS)

    // 抛壳：黄铜小盒，带重力/落地反弹/自旋。尺寸比真弹壳放大 ~1.5 倍 +
    // 微自发光：第一人称右下视野里抛出的壳要一眼可见（真实 11mm 反而看不见）
    const sGeo = new THREE.BoxGeometry(0.017, 0.017, 0.04)
    const brass = new THREE.MeshStandardMaterial({ color: 0xd9b25e, metalness: 0.9, roughness: 0.3, emissive: 0x2a1d05 })
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

    // 头盔（爆头击杀飞出）：小半球池，带重力/落地反弹/自旋/淡出
    const hGeo = new THREE.SphereGeometry(0.085, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)
    const hMat = new THREE.MeshStandardMaterial({ color: 0x3a3540, metalness: 0.55, roughness: 0.4, transparent: true })
    this.helmets = []
    for (let i = 0; i < MAX_HELMETS; i++) {
      const m = new THREE.Mesh(hGeo, hMat.clone())
      m.visible = false
      scene.add(m)
      this.helmets.push({ mesh: m, vel: new THREE.Vector3(), ang: new THREE.Vector3(), life: 0 })
    }
    this.helmetIdx = 0
  }

  // 每帧校准粒子尺寸（窗口/FOV 变化时调用；不调只影响点大小尺度）
  calibrate(width, height, fovDeg) {
    this.sparks.setViewportScale(height, fovDeg)
    this.puffs.setViewportScale(height, fovDeg)
    // 曳光束径随垂直 FOV 补偿：水平 FOV 固定 103°，宽屏/超宽屏的 vfov 更小，
    // 世界系束径投影到屏幕会更细——按 tan 半角比把束径拉回 16:9(vfov≈70.5°)
    // 基准的观感（限幅防极端长宽比）
    const ref = Math.tan(THREE.MathUtils.degToRad(70.5 / 2))
    this.tracerWScale = THREE.MathUtils.clamp(ref / Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)), 0.75, 2)
  }

  // style：曳光视觉参数。hue 默认 0.11（暖黄，玩家曳光）；敌方还击传红调
  // （hue ~0.02）——对枪瞬间一眼分清"哪条弹道是谁的"；消音武器传更淡/更细/
  // 低饱和（与更轻的枪声一致）。
  // impact：命中物类型——'wall'（暖色碎屑闪光）/ 'bot'（蓝白电火花：机器人
  // 装甲导电）→ 光段到达时按材质着色迸接触闪光；false = 擦身而过不闪
  // （Bot 曳光终点是相机近场钳制点，没有可打的表面）；true 兼容旧调用=暖色
  tracer(from, to, style = {}, impact = 'wall') {
    const { opacity = 0.85, sat = 0.92, light = 0.72, width = 1, hue: hueBase = 0.11 } = style
    // 近场钳制：端点离相机 <2m 时，盒体近端顶点的投影角尺寸爆炸，
    // 会把整条曳光拉成横穿屏幕的光柱（Bot 还击的束终点曾是相机位置，
    // 每次对枪失败都有一条戳脸光束）。贴脸端沿束方向推到 2m 外；
    // 两端都在近场则整条不画（贴脸射击本就不需要曳光）
    const cam = this.camera.position
    const dF = from.distanceTo(cam), dT = to.distanceTo(cam)
    const MIN = 2
    if (dF < MIN && dT < MIN) return
    let a = from, b = to
    if (dF < MIN) a = _ta.lerpVectors(from, to, (MIN - dF) / (dT - dF))
    if (dT < MIN) b = _tb.lerpVectors(from, to, (MIN - dT) / (dF - dT))
    const t = this.tracers[this.tracerIdx]
    this.tracerIdx = (this.tracerIdx + 1) % MAX_TRACERS
    const m = t.mesh
    t.from.copy(a)
    t.to.copy(b)
    t.dist = a.distanceTo(b)
    // 飞行曳光：短光段以 ~240m/s 掠过弹道（远距一段亮线飞向命中点）。
    // 近距（<8m，本训练器的典型交战距）切"闪现"模式：整条快闪 50ms——
    // 飞行段在短弹道上只是一次位置抖动，观感不如一道即逝的光痕
    const SPEED = 240
    if (t.dist < 8) {
      t.dur = 0.05
      t.seg = t.dist
    } else {
      t.dur = Math.max(0.028, t.dist / SPEED)
      t.seg = Math.min(5, t.dist)
    }
    t.width = width * (this.tracerWScale ?? 1)
    t.baseOp = opacity
    t.impact = impact
    // 出生帧补偿（与枪口焰同法，第一百二十三轮）：曳光在 simStep 生成，
    // 本帧 renderFrame 的 update 先扣整帧 dt 才首次上屏 → 实际可见寿命随
    // 出生相位折损一帧。+半帧（8ms）补回平均损失；update 里 fade 按
    // life/dur 计算，超额寿命会让首帧 fade 轻微 >1，无害（加法混合封顶）
    t.life = t.dur + 0.008
    m.visible = true
    // 着色器双色调：段头白热偏亮（亮度上探）、段尾同色系压暗压灰。
    // sat/light 来自 style（消音武器更淡更低饱和），hue 每发微扰动
    const hue = hueBase + vary() * 0.02
    const u = m.material.uniforms
    u.uHead.value.setHSL(hue, Math.min(1, sat), Math.min(1, light + 0.26))
    u.uTail.value.setHSL(hue, Math.min(1, sat * 0.85), light * 0.5)
    u.uAlpha.value = opacity
    // 每发亮度微抖动（±15%）：与色相抖动互补——连发曳光不是复制粘贴的光线
    t.bright = 0.85 + vary() * 0.3
    t.glow.material.color.setHSL(hue, Math.min(1, sat), Math.min(1, light + 0.2))
    t.halo.material.color.setHSL(hue, Math.min(1, sat * 0.9), Math.min(1, light + 0.1))
    // 初始矩阵由 update() 铺设（段头此刻就在枪口）
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

  // 枪口焰按武器风格参数化（默认=步枪）：
  //  suppressed：贴消音器的暗小火苗 + 弱光（消音枪不该有照明弹般的火球）
  //  heavy：大口径（Sheriff）更大更亮的火球与更硬的照明
  // opacity=焰基准不透明度（update 按其比例衰减）；
  // lightPeak=照明峰值（绝对值）或 light=峰值倍率（×16，二者取先传者）
  muzzle(worldPos, { scale = 1, opacity = 0.9, lightPeak = null, light = 1, lightDur = 0.06, color = 0xffbe7a, flashColor } = {}) {
    const peak = lightPeak ?? 16 * light
    if (worldPos) this.flash.position.copy(worldPos)
    this.flash.visible = true
    this.flashBase = opacity
    this.flash.material.opacity = opacity
    this.flash.material.rotation = vary() * Math.PI * 2
    this.flash.material.color.setHex(flashColor ?? 0xffffff)
    const s = (0.26 + vary() * 0.14) * scale
    this.flash.scale.set(s, s, 1)
    // +半帧：update 在本帧渲染前先扣整帧 dt（见 update 注释），补回平均损失
    this.flashLife = 0.045 + 0.008
    if (worldPos) {
      this.flashLight.position.copy(worldPos)
      this.flashLight.color.setHex(color)
      this.lightPeak = peak
      this.lightDur = lightDur
      this.lightLife = lightDur + 0.008
      // vmScene 通道同款闪光：枪口世界位换算到相机本地系（vmScene 世界系）。
      // 距离尺度小一个量级（0.2-0.5m），峰值按平方衰减比例取 1.2。
      // 仅玩家开火参与（WeaponSystem 传 Vector3；bot 擦身弹道传普通对象，
      // 且 bot 枪口位映到相机系毫无意义）
      if (this.vmFlash && worldPos.isVector3) {
        this.vmFlash.position.copy(this.camera.worldToLocal(worldPos.clone()))
        this.vmFlash.color.setHex(color)
        this.vmPeak = 1.2 * (peak / 16)
      }
    }
  }

  // 爆闪照明点亮第一人称通道：爆点在数米外、且传普通坐标对象——muzzle 的
  // vmFlash 映射分支不会触发；这里把 vmFlash 放到枪口正前方 0.45m（vmFlashLight
  // 有效距离 0.7m 内），以道具类型色照亮枪身+手套（强度随 muzzle 设的
  // lightLife/lightDur 同步衰减）
  vmPopGlow(colorHex, peak = 2.5) {
    if (!this.vmFlash) return
    this.vmFlash.position.set(0, 0, -0.45)
    this.vmFlash.color.setHex(colorHex)
    this.vmPeak = peak
  }

  // 墙面/硬表面命中：碎屑火花 + 尘雾。地面（ny>0.7）火花减半、尘雾翻倍——
  // 与 surfaceHit 的地面闷"噗"音色同一套材质判定，音画一致
  impact(x, y, z, nx, ny, nz) {
    const floor = ny > 0.7
    const nSparks = floor ? 4 : 8
    for (let i = 0; i < nSparks; i++) {
      const sp = 1.2 + vary() * 2.6
      _v.set(nx + (vary() - 0.5) * 1.4, ny + vary() * 1.1, nz + (vary() - 0.5) * 1.4).normalize().multiplyScalar(sp)
      this.sparks.emit(x, y, z, _v.x, _v.y, _v.z, {
        life: 0.16 + vary() * 0.22, size: 0.022 + vary() * 0.02,
        r: 1, g: 0.82 + vary() * 0.15, b: 0.55, grav: 6, drag: 1.5,
      })
    }
    const nPuffs = floor ? 2 : 1
    for (let i = 0; i < nPuffs; i++) {
      this.puffs.emit(x + nx * 0.03 + (vary() - 0.5) * 0.05, y + ny * 0.03, z + nz * 0.03 + (vary() - 0.5) * 0.05,
        nx * 0.3 + (vary() - 0.5) * 0.3, 0.35 + vary() * 0.25, nz * 0.3 + (vary() - 0.5) * 0.3,
        { life: 0.5 + vary() * 0.25, size: 0.1, sizeEnd: 0.34, r: 0.62, g: 0.58, b: 0.52, alpha: 0.34, drag: 1.6 })
    }
  }

  // 命中机器人（非致命）：火花迸溅（爆头更密 + 泛红 + 白闪芯）。
  // dir=弹道方向（玩家→命中点）：反弹半球约束——火星朝玩家侧崩射。
  // power=伤害力度（0.4-1.4）：火花密度/初速与踉跄幅度同因子联动——
  // Sheriff 一记 55 伤火星又密又急，Classic 轻点稀稀拉拉
  hitBurst(point, head, dir = null, power = 1) {
    const p = point ?? { x: 0, y: 1.3, z: 0 }
    const k = 0.7 + 0.5 * power
    const n = Math.round((head ? 18 : 11) * k)
    const spd = 0.8 + 0.3 * power
    if (dir) _kd.set(dir.x, dir.y, dir.z).normalize().negate()
    for (let i = 0; i < n; i++) {
      _v.set(vary() - 0.5, vary() * 0.9, vary() - 0.5).normalize()
      if (dir) _v.addScaledVector(_kd, 1.15).normalize()
      _v.multiplyScalar((1.4 + vary() * 3.2) * spd)
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

  // 击杀：大爆发 + 膨胀冲击波环 + 光脉冲（机器人 = 电火花过载 + 上升烟柱）。
  // streak=连杀数（1 起）：火花密度每级 +4（封顶 +16）、主灯与第一人称辉光
  // 向金色递进、峰值抬升——高连杀"越打越烫"（红 #ff6a55 → 金 #ffd27a，
  // 与击杀音的连杀升调同一语言）。
  // dir=弹道方向（玩家→命中点）：火花被约束在反弹半球（朝玩家侧溅射）——
  // 打在装甲上的火星往回崩，不是凭空全向爆
  killBurst(point, head, streak = 1, dir = null, heavy = false) {
    const p = point ?? { x: 0, y: 1.3, z: 0 }
    const n = (head ? 44 : 30) + Math.min(16, (streak - 1) * 4)
    if (dir) _kd.set(dir.x, dir.y, dir.z).normalize().negate() // 命中面反弹法线（朝玩家）
    for (let i = 0; i < n; i++) {
      _v.set(vary() - 0.5, vary() * 1.1 - 0.15, vary() - 0.5).normalize()
      if (dir) _v.addScaledVector(_kd, 1.15).normalize() // 半球约束：基准朝玩家 + 散射
      _v.multiplyScalar(2 + vary() * 4.6)
      const warm = vary()
      this.sparks.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, {
        life: 0.26 + vary() * 0.5, size: 0.026 + vary() * 0.03,
        r: 1, g: head ? 0.42 + warm * 0.35 : 0.6 + warm * 0.3, b: head ? 0.3 : 0.35, grav: 7, drag: 1.6,
      })
    }
    // 命中点白闪爆芯：爆头 4 粒大（0.09-0.14m），普通击杀 2 粒小（0.07-0.10m）
    // ——对称但弱一档的命中"啪"闪，普通击杀也有分量、层级仍分明
    const coreN = head ? 4 : 2
    for (let i = 0; i < coreN; i++) {
      _v.set(vary() - 0.5, vary() - 0.5, vary() - 0.5).normalize().multiplyScalar(0.8 + vary() * 1.4)
      this.sparks.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z,
        { life: 0.055 + vary() * 0.035, size: head ? 0.09 + vary() * 0.05 : 0.07 + vary() * 0.03, r: 1, g: 1, b: 0.96, drag: 3.5 })
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
    r.life = (r.dur = head ? 0.42 : 0.34) + 0.008 // +半帧出生补偿（瞬态族第四员）
    r.maxScale = head ? 2.0 : 1.5
    // 光脉冲：主场景灯在击杀点（世界被照亮），第一人称通道同款辉光
    // （枪身+手套吃到击杀光，峰值略高于枪口焰的 1.2——击杀读得出来）。
    // 连杀递进：色向金 #ffd27a 插值（每级 22%，3 连杀起明显）、峰值 +0.25/级。
    // heavy=大口径（Sheriff）：光脉冲更深更久（×1.25 峰值 / 0.22s 驻留）——
    // 与它的深低频枪声、重锤击锤同一份"重"的语言
    const k = Math.min(1, (streak - 1) * 0.22)
    _kc.setHex(head ? 0xff6a55 : 0xffa050).lerp(_kg.setHex(0xffd27a), k)
    this.flashLight.position.set(p.x, p.y + 0.2, p.z)
    this.flashLight.color.copy(_kc)
    this.lightPeak = ((head ? 26 : 18) + (streak - 1) * 0.25 * 16) * (heavy ? 1.25 : 1)
    this.lightDur = heavy ? 0.22 : 0.16
    this.lightLife = this.lightDur + 0.008 // +半帧出生补偿（与枪口焰/曳光同法）
    if (this.vmFlash) {
      this.vmFlash.position.set(0, 0, -0.5)
      this.vmFlash.color.copy(_kc)
      this.vmPeak = ((head ? 1.9 : 1.5) + (streak - 1) * 0.25) * (heavy ? 1.2 : 1)
    }
  }

  // 枪口烟（持续射击更浓）：顺着弹道方向的淡烟丝，heat 0..1 控制密度与尺寸。
  // 高热烟色更暗更灰（未燃尽火药的浓烟）——连射久了不只烟多，烟也"变脏"
  muzzleSmoke(worldPos, dir, heat = 0) {
    const n = 2 + Math.round(heat * 3)
    for (let i = 0; i < n; i++) {
      this.puffs.emit(
        worldPos.x + (vary() - 0.5) * 0.02, worldPos.y + (vary() - 0.5) * 0.02, worldPos.z + (vary() - 0.5) * 0.02,
        dir.x * (0.5 + vary() * 0.8) + (vary() - 0.5) * 0.3,
        dir.y * (0.5 + vary() * 0.8) + 0.25 + vary() * 0.25,
        dir.z * (0.5 + vary() * 0.8) + (vary() - 0.5) * 0.3,
        {
          life: 0.4 + vary() * 0.4 + heat * 0.3, size: 0.05,
          sizeEnd: 0.18 + heat * 0.14,
          r: 0.78 - heat * 0.26, g: 0.77 - heat * 0.26, b: 0.75 - heat * 0.24,
          alpha: 0.15 + heat * 0.17, drag: 2.2,
        })
    }
  }

  // 抛壳（世界坐标抛壳口；refMatrix = 枪身世界矩阵 → 沿枪身右/上/后抛出）
  // 爆头击杀：头盔从头部位置飞出（上抛 + 随机侧旋，落地反弹后淡出）。
  // dir=弹道方向（可选）：头盔顺着子弹来向被"掀飞"（动量守恒的读法），
  // 与击杀辉光同帧强化爆头瞬间的力度感
  helmetPop(point, dir = null) {
    const p = point ?? { x: 0, y: 1.6, z: 0 }
    const h = this.helmets[this.helmetIdx]
    this.helmetIdx = (this.helmetIdx + 1) % MAX_HELMETS
    const m = h.mesh
    m.position.set(p.x, p.y + 0.08, p.z)
    h.vel.set((vary() - 0.5) * 1.6, 2.6 + vary() * 1.2, (vary() - 0.5) * 1.6)
    if (dir) h.vel.addScaledVector(dir, 1.2 + vary() * 0.6) // 顺弹道方向的掀飞冲量
    h.ang.set(vary() * 10 - 5, vary() * 10 - 5, vary() * 10 - 5)
    h.life = 1.4
    m.rotation.set(vary() * 3, vary() * 3, vary() * 3)
    m.material.opacity = 1
    m.visible = true
  }

  shell(worldPos, refMatrix) {
    const s = this.shells[this.shellIdx]
    this.shellIdx = (this.shellIdx + 1) % MAX_SHELLS
    const m = s.mesh
    m.position.copy(worldPos)
    const ref = refMatrix ?? this.camera.matrixWorld
    _v.setFromMatrixColumn(ref, 0) // right
    s.vel.copy(_v).multiplyScalar(1.4 + vary() * 0.8)
    _v.setFromMatrixColumn(ref, 1) // up
    s.vel.addScaledVector(_v, 1.7 + vary() * 0.8)
    _v.setFromMatrixColumn(ref, 2) // back
    s.vel.addScaledVector(_v, 0.4 + vary() * 0.4)
    s.ang.set(vary() * 14 - 7, vary() * 14 - 7, vary() * 14 - 7)
    s.life = 2.2
    m.rotation.set(vary() * 3, vary() * 3, vary() * 3)
    m.visible = true
  }

  update(dt) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue
      t.life -= dt
      if (t.life <= 0) {
        t.mesh.visible = false
        t.glow.visible = false
        t.halo.visible = false
        // 到达火花已移除（查重结论）：hitBurst/impact 在击发帧即出全套命中 FX，
        // 曳光到达再补一簇小花是双份且晚 dist/240（40-100ms）错拍——
        // 命中瞬间的读法以即时 FX 为准，曳光只负责"飞过去"的路径表现
        continue
      }
      // 飞行进度：段头从枪口冲向命中点，段尾落后 seg 米（钳在弹道内）
      const p = 1 - t.life / t.dur
      const head = p * t.dist
      const tail = Math.max(0, head - t.seg)
      const m = t.mesh
      _v.subVectors(t.to, t.from).normalize()
      // 末段冲刺（彗尾效应）：最后 25% 行程光带纵向拉伸至 ×1.35——配合渐隐
      // 读成"加速冲向命中点"的拖影（子弹不加速，视觉修辞成立）
      const rush = t.life < t.dur * 0.25 ? 1 + 0.35 * (1 - t.life / (t.dur * 0.25)) : 1
      m.material.uniforms.uRush.value = rush - 1 // 0..0.35，shader 内按 50% 白热偏移
      m.position.copy(t.from).addScaledVector(_v, tail)
      m.lookAt(t.to)
      m.scale.set(t.width, t.width, Math.max((head - tail) * rush, 0.1))
      m.updateMatrix()
      // 末段 30% 渐隐（撞点前光段自然熄灭）；段头光珠随弹头飞行，头部更亮；
      // 亮度乘每发抖动系数 t.bright（±15%，连发不重样）
      const fade = Math.min(1, t.life / (t.dur * 0.3)) * (t.bright ?? 1)
      m.material.uniforms.uAlpha.value = fade * t.baseOp
      const gl = t.glow
      gl.visible = true
      gl.position.copy(t.from).addScaledVector(_v, head)
      gl.material.opacity = fade * t.baseOp
      gl.scale.setScalar((0.06 + 0.02 * t.width) * (0.7 + 0.3 * rush)) // 冲刺段光珠微缩=速度感
      // halo：更大更淡的外层泛光（×0.35 透明度、×3 尺寸）——亮场景里的存在感
      const ha = t.halo
      ha.visible = true
      ha.position.copy(gl.position)
      ha.material.opacity = fade * t.baseOp * 0.35
      ha.scale.setScalar(gl.scale.x * 3)
    }
    for (const d of this.decals) {
      if (d.life <= 0) continue
      d.life -= dt
      if (d.life < 3) d.mesh.material.opacity = Math.max(0, d.life / 3) * 0.95
      if (d.life <= 0) d.mesh.visible = false
    }
    if (this.flashLife > 0) {
      this.flashLife -= dt
      // 出生帧补偿：火苗在 simStep 生成，本帧 renderFrame 的 update 先扣掉整帧
      // dt 才首次上屏 → 实际可见寿命 29-45ms 随出生相位抖动（亮度忽明忽暗）。
      // muzzle() 里已 +半帧（0.008s），这里 clamp 到 1 保证峰值不超基准
      this.flash.material.opacity = Math.min(1, Math.max(0, this.flashLife / 0.045)) * this.flashBase
      if (this.flashLife <= 0) this.flash.visible = false
    }
    // 动态光衰减（主场景灯 + vmScene 灯同步）
    if (this.lightLife > 0) {
      this.lightLife -= dt
      const k = Math.min(1, Math.max(0, this.lightLife / this.lightDur))
      this.flashLight.intensity = this.lightPeak * k
      if (this.vmFlash) this.vmFlash.intensity = this.vmPeak * k
    } else if (this.flashLight.intensity !== 0) {
      this.flashLight.intensity = 0
      if (this.vmFlash) this.vmFlash.intensity = 0
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
        const impactV = -s.vel.y
        s.mesh.position.y = 0.012
        s.vel.y *= -0.32
        s.vel.x *= 0.72; s.vel.z *= 0.72
        s.ang.multiplyScalar(0.5)
        if (impactV > 0.9) this.onShellBounce?.(Math.min(1, impactV / 2.5))
        if (Math.abs(s.vel.y) < 0.5) s.vel.y = 0
      }
      s.mesh.rotation.x += s.ang.x * dt
      s.mesh.rotation.y += s.ang.y * dt
      s.mesh.rotation.z += s.ang.z * dt
    }
    // 头盔物理：同抛壳的重力/反弹，外加淡出
    for (const h of this.helmets) {
      if (h.life <= 0) continue
      h.life -= dt
      if (h.life <= 0) { h.mesh.visible = false; continue }
      h.vel.y -= 13 * dt
      h.mesh.position.addScaledVector(h.vel, dt)
      if (h.mesh.position.y < 0.05 && h.vel.y < 0) {
        const impactV = -h.vel.y
        h.mesh.position.y = 0.05
        h.vel.y *= -0.38
        h.vel.x *= 0.7; h.vel.z *= 0.7
        // 碰撞火花补发：金属壳拍地迸几点暖白碎火，与 helmetClank 同帧——
        // 弹点强度决定火花数（首次拍地 6 点，后续弹跳递减）
        if (impactV > 0.9) {
          const nSpk = Math.min(6, Math.round(impactV * 1.8))
          for (let i = 0; i < nSpk; i++) {
            _v.set((vary() - 0.5) * 2.4, 0.4 + vary() * 1.2, (vary() - 0.5) * 2.4)
            this.sparks.emit(h.mesh.position.x, 0.05, h.mesh.position.z, _v.x, _v.y, _v.z,
              { life: 0.1 + vary() * 0.12, size: 0.018 + vary() * 0.014, r: 1, g: 0.9, b: 0.72, grav: 9, drag: 2.5 })
          }
        }
        h.ang.multiplyScalar(0.55)
        // 带落点坐标：头盔在 10-25m 外弹地，必须空间化（否则"哐"在脑袋里响）
        if (impactV > 0.9) this.onHelmetBounce?.(Math.min(1, impactV / 2.5), h.mesh.position.x, h.mesh.position.y, h.mesh.position.z)
        if (Math.abs(h.vel.y) < 0.5) h.vel.y = 0
      }
      h.mesh.rotation.x += h.ang.x * dt
      h.mesh.rotation.y += h.ang.y * dt
      h.mesh.rotation.z += h.ang.z * dt
      if (h.life < 0.4) h.mesh.material.opacity = h.life / 0.4
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

  // 回合重置：清掉上一局残留的弹孔/曳光/弹壳/火花/烟/环/头盔 —— 新回合干净靶场
  clearAll() {
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; t.glow.visible = false; t.halo.visible = false }
    for (const d of this.decals) { d.life = 0; d.mesh.visible = false }
    for (const s of this.shells) { s.life = 0; s.mesh.visible = false }
    for (const r of this.rings) { r.life = 0; r.mesh.visible = false }
    for (const h of this.helmets) { h.life = 0; h.mesh.visible = false }
    this.sparks.n = 0
    this.puffs.n = 0
    this.flashLife = 0; this.flash.visible = false
    this.lightLife = 0; this.flashLight.intensity = 0
    if (this.vmFlash) this.vmFlash.intensity = 0
  }
}

const _dq = new THREE.Quaternion()
const _fwd = new THREE.Vector3(0, 0, 1)
const _n = new THREE.Vector3()
const _v = new THREE.Vector3()
const _kd = new THREE.Vector3()
const _kc = new THREE.Color()
const _kg = new THREE.Color()
const _ta = new THREE.Vector3()
const _tb = new THREE.Vector3()
