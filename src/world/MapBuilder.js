import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Tex, pbr } from './Textures.js'

// 训练馆布局（原创设计，尺寸按游戏内比例）：
//   主厅 x∈[-16,16], z∈[6,-46]
//   - 架枪巷道：z=-24 处横墙只开一个缺口（位置由设置选左/右），Bot 在墙后 z=-30 横向拉出
//   - 中场木箱掩体若干（高 1.2 / 2.4，换点位架枪 / 练习绕点预瞄）
// v2 视觉：地面距离标线+数字 / 缺口警示条纹横梁 / 墙面灯带 / 踢脚线 / 远端场馆标牌
export class MapBuilder {
  // side: 'left' 缺口 x∈[-9,-6] / 'right' 缺口 x∈[3,7]（左右位置镜像等距，视线调校一致）
  constructor(world, scene, side = 'left') {
    this.world = world
    this.scene = scene
    this.spawn = { x: 0, z: 0, yaw: 0 }
    this.gaps = []        // 巷道缺口 { x0, x1 }（恒为 1 个，位置随 side）
    this._signCache = {}
    this._meshes = []     // 挂进场景的全部静态 mesh（rebuild 时统一回收）
    this.rebuild(side)
  }

  get side() { return this._side }

  // 切换缺口左右：回收旧静态几何后重排（PBR 纹理是单例缓存，重建只是重摆几何）
  rebuild(side = this._side) {
    for (const m of this._meshes) {
      this.scene.remove(m)
      m.geometry?.dispose()
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) {
        for (const k of ['map', 'roughnessMap', 'normalMap', 'emissiveMap']) mat?.[k]?.dispose?.()
        mat?.dispose?.()
      }
    }
    this._meshes.length = 0
    // 标牌 clone 共享缓存原型的几何/材质（上面已随 clone dispose），清缓存待下次重建
    this._signCache = {}
    this.world.solids.length = 0
    this._side = side === 'right' ? 'right' : 'left'
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

    // ===== 架枪巷道：z=-24 横墙，单缺口（左 x∈[-9,-6] / 右 x∈[3,7]）=====
    const gap = this._side === 'right' ? { x0: 3, x1: 7 } : { x0: -9, x1: -6 }
    for (const [a, b] of [[-17, gap.x0], [gap.x1, 17]]) {
      box(geos.wall, (a + b) / 2, 0, -24, b - a, 4, 0.8)
    }
    const gapCx = (gap.x0 + gap.x1) / 2, gapW = gap.x1 - gap.x0
    box(geos.accent, gapCx, 4.05, -24, gapW + 0.4, 0.15, 1.1, false) // 缺口上沿标记
    // 缺口警示条纹横梁（门楣，快速识别架枪点位）
    box(geos.stripe, gapCx, 3.72, -23.6, gapW + 1.2, 0.24, 0.16, false)
    this.gaps = [gap]
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
        this._meshes.push(m)
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
    this._meshes.push(board)

    // ===== 中场掩体木箱（全部留在主厅 z>-24：巷道内不放箱，保证缺口视线干净）=====
    const crates = [
      [-4.2, -12, 1.2], [5, -15, 2.4], [-2, -20, 1.2],
      [2, -8, 1.2], [-8, -5, 1.2], [10, -6, 2.4],
      [-12, -19, 1.2], [11, -21, 2.4],
    ]
    for (const [x, z, h] of crates) {
      box(geos.crate, x, 0, z, 1.6, h, 1.6)
      // 箱顶描边色块（快速视觉识别）
      box(geos.accent, x, h, z, 1.65, 0.06, 1.65, false)
    }

    // 出生点：缺口正前方架枪位——进局即对口架枪（要换位随时可以走）
    this.spawn = { x: gapCx, z: -17, yaw: 0 }

    // 合并静态几何 → 每种材质 1 个 draw call
    for (const [key, arr] of Object.entries(geos)) {
      if (!arr.length) continue
      const merged = mergeGeometries(arr, false)
      const mesh = new THREE.Mesh(merged, mats[key])
      mesh.matrixAutoUpdate = false
      // 真实阴影：围/墙/箱投影 + 地板/墙面接收（renderer.shadowMap 关闭时零成本）
      mesh.castShadow = key !== 'floor' && key !== 'lamp'
      mesh.receiveShadow = key !== 'lamp'
      this.scene.add(mesh)
      this._meshes.push(mesh)
      for (const g of arr) g.dispose()
    }
  }
}
