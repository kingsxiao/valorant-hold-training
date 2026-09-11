import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { CONFIG } from './Config.js'

// 引擎：渲染器 / 场景 / 相机 / 固定步长主循环 / FPS 统计
export class Engine {
  constructor(canvas) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, CONFIG.graphics.maxPixelRatio))
    this.renderer.shadowMap.enabled = CONFIG.graphics.shadows
    this.renderer.shadowMap.type = THREE.PCFShadowMap // PCFSoft 在 r185 已弃用（PCF 本身即软过滤）
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.06

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(CONFIG.colors.sky)
    this.scene.fog = new THREE.Fog(CONFIG.colors.fog, 60, 170)

    // 环境反射贴图：让金属/皮肤等 Standard 材质有真实的高光与反射（一次性生成）
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()

    // 天空穹顶：垂直渐变 + 太阳光斑（比平涂背景更有空间感）
    this._buildSky()

    this.camera = new THREE.PerspectiveCamera(71, 1, 0.05, 300)
    this.camera.rotation.order = 'YXZ'
    this.scene.add(this.camera) // 相机入场景图：枪口焰点光等作为相机子节点才会被渲染

    // ---- 第一人称持枪独立渲染 pass（成熟 FPS 通用做法）----
    // viewmodel 用自己的窄 FOV 相机单独一趟渲染：枪/手臂比例不随主视野(103°)变形，
    // 清深度后叠加 → 永不穿墙、不被墙裁剪。vmCamera 固定于原点无旋转：
    // 其"世界系"即相机本地系，持枪模型挂它下面天然只随视角动、不随位置动。
    this.vmScene = new THREE.Scene()
    this.vmScene.environment = this.scene.environment
    this.vmCamera = new THREE.PerspectiveCamera(CONFIG.graphics.viewmodelFov, 1, 0.01, 8)
    this.vmScene.add(this.vmCamera)
    const vmHemi = new THREE.HemisphereLight(0xcfe5f2, 0x8a7a63, 0.72)
    const vmSun = new THREE.DirectionalLight(0xfff2dc, 1.05)
    vmSun.position.set(28, 46, 18) // 与主场景太阳同向 → 枪身光影与场景一致
    this.vmScene.add(vmHemi, vmSun)
    // 枪口焰点光（FX.muzzle 驱动）：vmScene 独立渲染通道吃不到主场景的
    // flashLight → 开火时枪身/手套无瞬时高光。此灯在相机本地系（=vmScene
    // 世界系）跟随枪口，强度由 FX 与主场景灯同步衰减
    this.vmFlashLight = new THREE.PointLight(0xffbe7a, 0, 0.7, 2)
    this.vmScene.add(this.vmFlashLight)

    // ---- 热浪扭曲 pass（可行性原型）----
    // 主场景渲到 RT → 全屏 quad 采样，在枪口屏幕区域施加程序化 UV 扰动
    // （强度∝连射热量，WeaponSystem 每帧喂 this.shimmer）→ 清深度画持枪层
    // （枪/手套不被扰动，保持锐利）。无纹理依赖：三层正弦流动噪声
    this.shimmer = { x: 0.5, y: 0.5, heat: 0 }
    this.heatShimmer = CONFIG.graphics.heatShimmer !== false // 菜单画质开关（main.applyAll 写入）
    this._rt = new THREE.WebGLRenderTarget(2, 2)
    this._postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this._postScene = new THREE.Scene()
    this._postScene.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: this._rt.texture },
          uMuzzle: { value: new THREE.Vector2(0.5, 0.5) },
          uHeat: { value: 0 },
          uTime: { value: 0 },
          uAspect: { value: 1 },
        },
        vertexShader: /* glsl */`
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: /* glsl */`
          uniform sampler2D tDiffuse;
          uniform vec2 uMuzzle;
          uniform float uHeat, uTime, uAspect;
          varying vec2 vUv;
          // 廉价流动噪声：三层不同频率/速度的正弦叠加（无纹理依赖）
          float wob(vec2 p) {
            return sin(p.y * 43.0 + uTime * 9.0) * 0.5
                 + sin(p.x * 61.0 - p.y * 29.0 + uTime * 13.0) * 0.35
                 + sin((p.x + p.y) * 83.0 + uTime * 21.0) * 0.15;
          }
          void main() {
            vec2 d = vUv - uMuzzle;
            d.x *= uAspect;
            // 枪口热气区：径向高斯衰减 × 向上偏置的椭圆（热气往上走）
            float mask = exp(-dot(d, d) * 34.0) * smoothstep(-0.06, 0.12, d.y);
            float amp = uHeat * 0.0045 * mask;
            vec2 off = vec2(wob(vUv * 7.0 + uTime * 0.7), wob(vUv.yx * 6.0 - uTime * 0.5) * 0.6) * amp;
            gl_FragColor = texture2D(tDiffuse, vUv + off);
            #include <colorspace_fragment>
          }`,
        depthTest: false, depthWrite: false,
      }),
    ))
    // 注：vmScene 三盏灯均不投影、不随菜单"阴影"开关变化 → 第一人称深灰手套
    // 材质在各图形档位（阴影开/关、分辨率缩放）下渲染恒一致（2026-09-07 核验：
    // 开关阴影仅主场景地面阴影变化，vmScene 输出不受影响；resScale 只改像素比）

    // 光照：半球光（天空补光）+ 平行光（太阳）+ 环境反射，强度按 ACES 色调映射调校避免过曝
    const hemi = new THREE.HemisphereLight(0xcfe5f2, 0x8a7a63, 0.72)
    this.scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xfff2dc, 1.05)
    sun.position.set(28, 46, 18)
    sun.castShadow = true // 阴影贴图只在 renderer.shadowMap.enabled 时分配/使用，可运行时切换
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -40; sun.shadow.camera.right = 40
    sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40
    sun.shadow.camera.far = 120
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.03 // 消自阴影痤疮（墙面/箱体大面积接收面）
    this.scene.add(sun)
    this.sun = sun

    // 主循环状态
    this.fixedDt = 1 / CONFIG.sim.tickHz
    this.accumulator = 0
    this.lastTime = 0
    this.running = false
    this.fovH = CONFIG.graphics.fovH // 当前水平 FOV（ADS 开镜时被 setFovH 缩放）

    // 自适应分辨率：autoRes 总开关 + 自动乘数（与用户手动缩放相乘）
    this.autoRes = true
    this.autoScale = 1
    this.userScale = 1
    this._resAccum = 0

    // FPS 统计（环形缓冲）
    this.frameTimes = new Float32Array(600)
    this.frameIdx = 0
    this.fps = 0
    this.frameMs = 0
    this.low1Pct = 0

    this.simStep = null   // (dt) => void   固定 128Hz 逻辑
    this.renderFrame = null // (alpha, dtMs) => void  每渲染帧
    this.preFrame = null  // 每渲染帧最前（鼠标视角先于逻辑步应用 → 零延迟跟手）

    this._resize()
    addEventListener('resize', () => this._resize())

    // WebGL 上下文丢失（系统压力/驱动重置）：停循环防止报错刷屏；
    // 恢复后强制全材质重编译并重启 —— 程序化纹理/几何会随首次渲染重建
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault() // 允许 restored 事件
      this.stop()
      this.onContextLost?.()
    })
    canvas.addEventListener('webglcontextrestored', () => {
      // 双 pass 场景都要标记：vmScene（第一人称枪/手套）漏标会导致恢复后
      // 材质不重编译、渲染异常（2026-09-08 补）；热浪 pass 的全屏 quad 同理
      for (const sc of [this.scene, this.vmScene, this._postScene]) {
        sc.traverse(o => { if (o.material) o.material.needsUpdate = true })
      }
      this.start()
      this.onContextRestored?.()
    })
  }

  // Valorant 锁定水平 FOV 103°，垂直 FOV 随宽高比换算（保证不同窗口下视野一致）。
  // this.fovH 可被 setFovH 改写（ADS 开镜 ÷zoom 缩放），_resize 沿用当前值
  _resize() {
    const w = innerWidth, h = innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    const tanHalfH = Math.tan((this.fovH * Math.PI / 360))
    this.camera.fov = THREE.MathUtils.radToDeg(Math.atan(tanHalfH / this.camera.aspect)) * 2
    this.camera.updateProjectionMatrix()
    this.vmCamera.aspect = w / h
    this.vmCamera.updateProjectionMatrix()
    this._applyScale() // 跨屏拖动时 devicePixelRatio 变化，重设像素比防糊
  }

  // 水平 FOV 切换（ADS 开镜 103°→82.4°，随 adsBlend 每帧插值）。仅数值变化时
  // 重算投影（每帧调用零开销路径 = 一次比较直接返回）
  setFovH(degH) {
    if (this.fovH === degH) return
    this.fovH = degH
    const tanHalfH = Math.tan(degH * Math.PI / 360)
    this.camera.fov = THREE.MathUtils.radToDeg(Math.atan(tanHalfH / this.camera.aspect)) * 2
    this.camera.updateProjectionMatrix()
  }

  // 天空穹顶：程序化渐变贴图 + 太阳精灵（跟随相机，永不触及雾）
  _buildSky() {
    const c = document.createElement('canvas')
    c.width = 4; c.height = 256
    const g = c.getContext('2d')
    const grad = g.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, '#5f87a6')   // 天顶
    grad.addColorStop(0.5, '#8fb0c7')
    grad.addColorStop(0.82, '#d5dfe6') // 地平线
    grad.addColorStop(1, '#e4e6df')
    g.fillStyle = grad
    g.fillRect(0, 0, 4, 256)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(200, 24, 16),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }),
    )
    sky.renderOrder = -10
    this.scene.add(sky)
    // 太阳（贴着平行光方向）
    const sunCanvas = document.createElement('canvas')
    sunCanvas.width = sunCanvas.height = 128
    const sg = sunCanvas.getContext('2d')
    const rg = sg.createRadialGradient(64, 64, 4, 64, 64, 64)
    rg.addColorStop(0, 'rgba(255,250,230,1)')
    rg.addColorStop(0.18, 'rgba(255,240,200,0.9)')
    rg.addColorStop(0.5, 'rgba(255,230,170,0.25)')
    rg.addColorStop(1, 'rgba(255,230,170,0)')
    sg.fillStyle = rg
    sg.fillRect(0, 0, 128, 128)
    const sunTex = new THREE.CanvasTexture(sunCanvas)
    sunTex.colorSpace = THREE.SRGBColorSpace
    const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, fog: false, depthWrite: false }))
    sunSprite.position.set(120, 190, 76)
    sunSprite.scale.set(70, 70, 1)
    this.scene.add(sunSprite)

    // 云：程序化软团贴图，几个大精灵贴在天穹上（不参与雾/深度），给天空层次
    const cc = document.createElement('canvas')
    cc.width = 256; cc.height = 128
    const cg2 = cc.getContext('2d')
    for (let i = 0; i < 14; i++) {
      const x = 30 + Math.random() * 196, y = 40 + Math.random() * 55, r = 18 + Math.random() * 34
      const rg = cg2.createRadialGradient(x, y, 2, x, y, r)
      rg.addColorStop(0, 'rgba(255,255,255,0.55)')
      rg.addColorStop(0.6, 'rgba(248,250,252,0.28)')
      rg.addColorStop(1, 'rgba(255,255,255,0)')
      cg2.fillStyle = rg
      cg2.fillRect(0, 0, 256, 128)
    }
    const cloudTex = new THREE.CanvasTexture(cc)
    cloudTex.colorSpace = THREE.SRGBColorSpace
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + Math.random() * 0.5
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.5 + Math.random() * 0.3,
        fog: false, depthWrite: false,
      }))
      s.position.set(Math.cos(ang) * 150, 62 + Math.random() * 45, Math.sin(ang) * 150)
      const w = 60 + Math.random() * 55
      s.scale.set(w, w * 0.42, 1)
      s.renderOrder = -9
      this.scene.add(s)
    }
  }

  start() {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.accumulator = 0
    // 开局首帧含着色器编译/纹理上传的长帧，清空统计避免 1% low 被启动卡顿污染
    this.frameTimes.fill(0)
    const loop = (now) => {
      if (!this.running) return
      this._raf = requestAnimationFrame(loop)

      let dtMs = now - this.lastTime
      this.lastTime = now
      if (dtMs > 250) dtMs = 250 // 切后台回来不追赶
      this._recordFrame(dtMs)
      this._adaptiveRes(dtMs)
      this.preFrame?.(dtMs / 1000)

      this.accumulator += dtMs / 1000
      let steps = 0
      while (this.accumulator >= this.fixedDt && steps < CONFIG.sim.maxStepsPerFrame) {
        this.simStep?.(this.fixedDt)
        this.accumulator -= this.fixedDt
        steps++
      }
      if (steps === CONFIG.sim.maxStepsPerFrame) this.accumulator = 0 // 过载保护

      this.renderFrame?.(this.accumulator / this.fixedDt, dtMs)
      this.renderer.autoClear = false
      // 热浪 pass 的成本门控：仅开火后的热量窗（~1.8s）内走 RT+扰动三段路径，
      // 平时（架枪/瞄准的绝大多数帧）旁路回直渲双 pass——零成本持有该特效。
      // 两条路径色彩管线等价（各自恰好一次 sRGB 编码），切换无视觉跳变
      if (this.heatShimmer !== false && this.shimmer.heat > 0.005) {
        const sh = this.shimmer
        const u = this._postScene.children[0].material.uniforms
        u.uMuzzle.value.set(sh.x, sh.y)
        u.uHeat.value = sh.heat
        u.uAspect.value = this.camera.aspect
        u.uTime.value = now / 1000
        this.renderer.setRenderTarget(this._rt)
        this.renderer.clear()
        this.renderer.render(this.scene, this.camera)
        this.renderer.setRenderTarget(null)
        this.renderer.render(this._postScene, this._postCam)
      } else {
        // 双 pass：主场景 → 清深度 → 持枪视角（永远画在世界之上、不穿墙）
        this.renderer.clear()
        this.renderer.render(this.scene, this.camera)
      }
      this.renderer.clearDepth()
      this.renderer.render(this.vmScene, this.vmCamera)
    }
    this._raf = requestAnimationFrame(loop)
  }

  stop() { this.running = false; cancelAnimationFrame(this._raf) }

  // 着色器/贴图预热：隐藏对象（枪口焰精灵、曳光段、弹孔…）的材质是懒编译的，
  // 首见才建 GPU 程序 —— 没有这步，回合第一枪会卡 ~100ms 等编译。开局空闲期
  // 调一次把两个场景全部材质初始化好（透明/加法对象 visible=false 也不会漏，
  // compile 走的是全量材质初始化而非渲染遍历）
  prewarm() {
    this.renderer.compile(this.scene, this.camera)
    this.renderer.compile(this.vmScene, this.vmCamera)
  }

  _recordFrame(dtMs) {
    this.frameMs = dtMs
    this.frameTimes[this.frameIdx] = dtMs
    this.frameIdx = (this.frameIdx + 1) % this.frameTimes.length
    // 每 30 帧结算一次：fps 取有效帧均值；1% low 取最差 1%（600 帧中的 6 帧）均值
    if (this.frameIdx % 30 === 0) {
      let sum = 0, n = 0, worst = 0
      for (let i = 0; i < this.frameTimes.length; i++) {
        const t = this.frameTimes[i]
        if (t > 0) { sum += t; n++; if (t > worst) worst = t }
      }
      if (n > 0) {
        this.fps = Math.round(1000 / (sum / n))
        // 最差 6 帧均值：用一次部分选择避免整段排序
        const lows = [0, 0, 0, 0, 0, 0]
        for (let i = 0; i < this.frameTimes.length; i++) {
          const t = this.frameTimes[i]
          if (t > lows[0]) {
            lows[0] = t
            for (let k = 1; k < lows.length && lows[k - 1] > lows[k]; k++) {
              const tmp = lows[k - 1]; lows[k - 1] = lows[k]; lows[k] = tmp
            }
          }
        }
        let lowSum = 0, m = 0
        for (const t of lows) { if (t > 0) { lowSum += t; m++ } }
        this.low1Pct = m > 0 ? Math.round(1000 / (lowSum / m)) : 0
      }
    }
  }

  setShadows(on) {
    this.renderer.shadowMap.enabled = on
    this.scene.traverse(o => { if (o.material) o.material.needsUpdate = true })
  }

  // 实际像素密度 = 手动分辨率缩放（菜单滑条）× 自适应乘数（掉帧自动降）
  setResolutionScale(s) {
    this.userScale = s
    this._applyScale()
  }

  _applyScale() {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, CONFIG.graphics.maxPixelRatio) * (this.userScale ?? 1) * (this.autoScale ?? 1))
    // 热浪 pass 的 RT 跟随绘制缓冲尺寸（像素比/分辨率缩放变化后同步）
    if (this._rt) {
      const s = new THREE.Vector2()
      this.renderer.getDrawingBufferSize(s)
      this._rt.setSize(s.x, s.y)
    }
  }

  // 自适应分辨率：帧率持续偏低时按 10% 步长降低渲染分辨率（最低 60%），
  // 帧率恢复后缓慢回升 —— 低配机器上保住手感优先；autoRes=false 时不动
  _adaptiveRes(dtMs) {
    if (!this.autoRes) { this._resAccum = 0; if (this.autoScale !== 1) { this.autoScale = 1; this._applyScale() } return }
    this._resAccum = (this._resAccum ?? 0) + dtMs
    if (this._resAccum < 800) return
    this._resAccum = 0
    if (this.fps > 0 && this.fps < 48 && this.autoScale > 0.6) {
      this.autoScale = Math.max(0.6, Math.round((this.autoScale - 0.1) * 100) / 100)
      this._applyScale()
    } else if (this.fps >= 58 && this.autoScale < 1) {
      this.autoScale = Math.min(1, Math.round((this.autoScale + 0.05) * 100) / 100)
      this._applyScale()
    }
  }
}
