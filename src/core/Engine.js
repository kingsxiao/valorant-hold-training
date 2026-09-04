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
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
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

    // 光照：半球光（天空补光）+ 平行光（太阳）+ 环境反射，强度按 ACES 色调映射调校避免过曝
    const hemi = new THREE.HemisphereLight(0xcfe5f2, 0x8a7a63, 0.72)
    this.scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xfff2dc, 1.05)
    sun.position.set(28, 46, 18)
    sun.castShadow = true // 阴影贴图只在 renderer.shadowMap.enabled 时分配/使用，可运行时切换
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.left = -45; sun.shadow.camera.right = 45
    sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45
    sun.shadow.camera.far = 120
    this.scene.add(sun)
    this.sun = sun

    // 主循环状态
    this.fixedDt = 1 / CONFIG.sim.tickHz
    this.accumulator = 0
    this.lastTime = 0
    this.running = false

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
      this.scene.traverse(o => { if (o.material) o.material.needsUpdate = true })
      this.start()
      this.onContextRestored?.()
    })
  }

  // Valorant 锁定水平 FOV 103°，垂直 FOV 随宽高比换算（保证不同窗口下视野一致）
  _resize() {
    const w = innerWidth, h = innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    const tanHalfH = Math.tan((CONFIG.graphics.fovH * Math.PI / 360))
    this.camera.fov = THREE.MathUtils.radToDeg(Math.atan(tanHalfH / this.camera.aspect)) * 2
    this.camera.updateProjectionMatrix()
    this.vmCamera.aspect = w / h
    this.vmCamera.updateProjectionMatrix()
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
  }

  start() {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.accumulator = 0
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
      // 双 pass：主场景 → 清深度 → 持枪视角（永远画在世界之上、不穿墙）
      this.renderer.autoClear = false
      this.renderer.clear()
      this.renderer.render(this.scene, this.camera)
      this.renderer.clearDepth()
      this.renderer.render(this.vmScene, this.vmCamera)
    }
    this._raf = requestAnimationFrame(loop)
  }

  stop() { this.running = false; cancelAnimationFrame(this._raf) }

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
