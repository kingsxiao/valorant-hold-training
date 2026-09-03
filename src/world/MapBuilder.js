import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Tex, pbr } from './Textures.js'

// 训练馆布局（原创设计，尺寸按游戏内比例）：
//   主厅 x∈[-16,16], z∈[6,-46]
//   - 架枪巷道：z=-24 处横墙带两个缺口，Bot 在墙后 z=-30 横向拉出
//   - 中场木箱掩体若干（高 1.2 / 2.4，换点位架枪 / 练习绕点预瞄）
// v2 视觉：地面距离标线+数字 / 缺口字母牌+警示条纹横梁 / 墙面灯带 / 踢脚线 / 远端场馆标牌
export class MapBuilder {
  constructor(world, scene) {
    this.world = world
    this.scene = scene
    this.spawn = { x: 0, z: 0, yaw: 0 }
    this.holdSpots = []   // 架枪推荐站位
    this.gaps = []        // 巷道缺口 { x0, x1 }
    this._signCache = {}
    this.build()
  }

  // 文字标牌：程序化 canvas 贴图 → 发光平面（夜间/阴影下仍可读）；同 key 共享几何/材质
  _sign(key, w, h, draw) {
    const make = () => {
      const c = document.createElement('canvas')
      c.width = 512
      c.height = Math.max(64, Math.round(512 * h / w))
      draw(c.getContext('2d'), c.width, c.height)
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 4
      const mat = new THREE.MeshStandardMaterial({
        map: tex, transparent: true, roughness: 0.85, metalness: 0,
        emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.3,
      })
      return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    }
    const proto = this._signCache[key] ??= make()
    return proto.clone() // 克隆共享几何与材质，仅变换独立
  }

  build() {
    const S = this.world.addSolid.bind(this.world)
    const mats = {
      floor: pbr({ maps: Tex.floor(), roughness: 0.92, repeat: [17, 28] }),
      wall: pbr({ maps: Tex.wall(), color: 0xd8ccba, roughness: 0.85, repeat: [8, 2] }),
      crate: pbr({ maps: Tex.crate(), roughness: 0.8 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x3d7068, roughness: 0.6, metalness: 0.1 }),
      red: new THREE.MeshStandardMaterial({ color: 0xc23b4e, roughness: 0.6 }),
      trim: new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.75, metalness: 0.25 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0x11150f, emissive: 0xffedc8, emissiveIntensity: 2.0, roughness: 0.4 }),
      stripe: pbr({ maps: Tex.stripes(), roughness: 0.6 }),
    }
    const geos = { floor: [], wall: [], crate: [], accent: [], red: [], trim: [], lamp: [], stripe: [] }
    const box = (arr, x, y, z, w, h, d, solid = true) => {
      const geo = new THREE.BoxGeometry(w, h, d)
      geo.translate(x, y + h / 2, z)
      arr.push(geo)
      if (solid) S(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2)
    }

    // 地板（2m 网格刻度帮助测距）
    const floorGeo = new THREE.BoxGeometry(34, 0.5, 56)
    floorGeo.translate(0, -0.25, -19.5)
    geos.floor.push(floorGeo)
    S(-17, -0.5, -48, 17, 0, 9.5)

    // 四周围墙（高 6m）
    box(geos.wall, 0, 0, 8, 34, 6, 1)     // 北（身后）
    box(geos.wall, 0, 0, -47.5, 34, 6, 1) // 南（靶道尽头）
    box(geos.wall, -17, 0, -19.5, 1, 6, 56) // 西
    box(geos.wall, 17, 0, -19.5, 1, 6, 56)  // 东

    // 墙面灯带（北/南各 3 组，东/西各 2 组 —— 半室外训练馆照明氛围）
    for (const x of [-10, 0, 10]) {
      box(geos.lamp, x, 5.1, 7.42, 2.6, 0.32, 0.1, false)
      box(geos.lamp, x, 5.1, -46.92, 2.6, 0.32, 0.1, false)
    }
    for (const z of [-10, -30]) {
      box(geos.lamp, -16.42, 5.1, z, 0.1, 0.32, 2.6, false)
      box(geos.lamp, 16.42, 5.1, z, 0.1, 0.32, 2.6, false)
    }

    // 踢脚线（深色墙裙，勾勒空间轮廓）
    box(geos.trim, 0, 0, 7.44, 34, 0.42, 0.12, false)
    box(geos.trim, 0, 0, -46.94, 34, 0.42, 0.12, false)
    box(geos.trim, -16.44, 0, -19.5, 0.12, 0.42, 56, false)
    box(geos.trim, 16.44, 0, -19.5, 0.12, 0.42, 56, false)

    // ===== 架枪巷道：z=-24 横墙，两个缺口 =====
    // 缺口 A x∈[-9,-6]（3m），缺口 B x∈[3,7]（4m）
    box(geos.wall, -13, 0, -24, 8, 4, 0.8)   // -17..-9
    box(geos.wall, -1.5, 0, -24, 9, 4, 0.8)  // -6..3
    box(geos.wall, 12, 0, -24, 10, 4, 0.8)   // 7..17
    box(geos.accent, -7.5, 4.05, -24, 3.4, 0.15, 1.1, false) // 缺口上沿标记
    box(geos.accent, 5, 4.05, -24, 4.4, 0.15, 1.1, false)
    // 缺口警示条纹横梁（门楣，快速识别架枪点位）
    box(geos.stripe, -7.5, 3.72, -23.6, 4.2, 0.24, 0.16, false)
    box(geos.stripe, 5, 3.72, -23.6, 5.2, 0.24, 0.16, false)
    // 缺口字母牌（A / B，报点用）
    const letter = (key, ch, x) => {
      const m = this._sign(key, 0.9, 0.9, (g, W, H) => {
        g.fillStyle = 'rgba(16,22,27,0.92)'; g.fillRect(0, 0, W, H)
        g.strokeStyle = '#ff4655'; g.lineWidth = 14; g.strokeRect(10, 10, W - 20, H - 20)
        g.fillStyle = '#ff4655'; g.font = `bold ${Math.round(H * 0.62)}px monospace`
        g.textAlign = 'center'; g.textBaseline = 'middle'
        g.fillText(ch, W / 2, H / 2 + 6)
      })
      m.position.set(x, 2.75, -23.56)
      m.matrixAutoUpdate = false
      m.updateMatrix()
      this.scene.add(m)
    }
    letter('gapA', 'A', -9.8)
    letter('gapB', 'B', 7.8)
    this.gaps.push({ x0: -9, x1: -6, name: 'A' }, { x0: 3, x1: 7, name: 'B' })
    // Bot 横移线（墙后 6m 处）
    this.peekLineZ = -30
    // 巷道后墙
    box(geos.wall, -13, 0, -36, 8, 4, 0.8)
    box(geos.wall, 12, 0, -36, 10, 4, 0.8)
    box(geos.wall, 0, 0, -36, 16, 4, 0.8)
    // 巷道两侧封口
    box(geos.wall, -16.5, 0, -30, 1, 4, 13)
    box(geos.wall, 16.5, 0, -30, 1, 4, 13)

    // ===== 地面距离标线 + 数字（每 10m 一道，练测距/预瞄）=====
    const distMark = (meters, z) => {
      box(geos.accent, 0, 0.005, z, 14, 0.012, 0.14, false) // 横向标线
      for (const x of [-8.6, 8.6]) {
        const m = this._sign('dist' + meters, 1.7, 0.85, (g, W, H) => {
          g.clearRect(0, 0, W, H)
          g.fillStyle = 'rgba(45,84,77,0.85)'
          g.font = `bold ${Math.round(H * 0.72)}px monospace`
          g.textAlign = 'center'; g.textBaseline = 'middle'
          g.fillText(meters + 'm', W / 2, H / 2)
        })
        m.rotation.x = -Math.PI / 2
        m.position.set(x, 0.014, z)
        m.matrixAutoUpdate = false
        m.updateMatrix()
        this.scene.add(m)
      }
    }
    distMark(10, -7); distMark(20, -17); distMark(30, -27); distMark(40, -37)

    // ===== 远端场馆标牌（南墙内面）=====
    const board = this._sign('title', 7.2, 1.7, (g, W, H) => {
      g.fillStyle = 'rgba(14,20,26,0.94)'; g.fillRect(0, 0, W, H)
      g.strokeStyle = '#ff4655'; g.lineWidth = 10; g.strokeRect(8, 8, W - 16, H - 16)
      g.textAlign = 'center'
      g.fillStyle = '#ece8e1'
      g.font = `bold ${Math.round(H * 0.34)}px sans-serif`
      g.fillText('RANGE-07 架枪训练馆', W / 2, H * 0.42)
      g.fillStyle = 'rgba(236,232,225,0.55)'
      g.font = `${Math.round(H * 0.16)}px sans-serif`
      g.fillText('架枪 · 对枪 · 反应', W / 2, H * 0.72)
    })
    board.position.set(0, 4.5, -46.9)
    board.matrixAutoUpdate = false
    board.updateMatrix()
    this.scene.add(board)

    // ===== 中场掩体木箱 =====
    const crates = [
      [-4.2, -12, 1.2], [5, -15, 2.4], [-2, -20, 1.2], [8, -26, 1.2],
      [-10, -28, 2.4], [2, -8, 1.2], [-8, -5, 1.2], [10, -6, 2.4],
    ]
    for (const [x, z, h] of crates) {
      box(geos.crate, x, 0, z, 1.6, h, 1.6)
      // 箱顶描边色块（快速视觉识别）
      box(geos.accent, x, h, z, 1.65, 0.06, 1.65, false)
    }

    // 架枪推荐站位（面向缺口）
    this.holdSpots = [
      { x: -7.5, z: -17, yaw: 0, gap: 0 },
      { x: 5, z: -17, yaw: 0, gap: 1 },
      { x: 0, z: -10, yaw: 0, gap: 0 },
    ]

    // 出生点：架枪位正后（中场掩体之间），面向两个缺口
    this.spawn = { x: 0, z: -14, yaw: 0 }

    // 合并静态几何 → 每种材质 1 个 draw call
    for (const [key, arr] of Object.entries(geos)) {
      if (!arr.length) continue
      const merged = mergeGeometries(arr, false)
      const mesh = new THREE.Mesh(merged, mats[key])
      mesh.matrixAutoUpdate = false
      this.scene.add(mesh)
      for (const g of arr) g.dispose()
    }
  }
}
