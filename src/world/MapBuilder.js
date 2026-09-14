import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Tex, pbr } from './Textures.js'

// 地图布局（无畏契约站点架构的架枪场景，原创几何按游戏内比例）：
//   主厅 x∈[-16,16], z∈[6,-46]；四面 6m 围墙（灰泥墙身 + 石砌墙基 + 檐口）
//   - A 点（玩家区 z>-24）：站点院落——下包区标线 + 地面 A 字 + 错位箱阵掩体
//   - A 门（z=-24 横墙，厚 1.6m）：唯一缺口（左/右由设置选），铆钉钢门套 + 门楣
//     压顶 + 警示条纹 + 壁灯——"一扇门"而不是"墙上的洞"；Bot 在墙后 z=-30 横向拉出
//   - Main 通道（z -36..-24）：门后纵深——壁柱节奏 + 站点定位牌 + 按 side 摆放的
//     通道箱（严格避开 Bot 行走带），透过门看到有掩体的真实空间
//   - 远景屋顶天际线（z<-40，玩家不可达）：陶瓦/灰泥体块 + 檐口，走近门口时
//     从 4m 横墙上方渐次露出"城镇"轮廓
// 训练不变量（锁死，任何视觉重构不得触碰）：gaps[0] 坐标、横墙 z=-24、
// peekLineZ=-30、spawn（缺口正前方）、rebuild(side) 左右镜像
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
    // 石材两种铺贴：墙基横铺（横向多段）与壁柱竖铺（纵向两段）——同一贴图按
    // 面向不同 repeat，石头比例都落在 0.4-0.7m 的真实尺度
    const mats = {
      floor: pbr({ maps: Tex.floor(), roughness: 0.92, repeat: [17, 28] }),
      wall: pbr({ maps: Tex.wall(), color: 0xd8ccba, roughness: 0.85, repeat: [8, 2] }),
      stoneBase: pbr({ maps: Tex.stone(), roughness: 0.95, repeat: [12, 1] }),
      stonePillar: pbr({ maps: Tex.stone(), roughness: 0.95, repeat: [1, 2] }),
      doorMetal: pbr({ maps: Tex.doorMetal(), roughness: 0.55, metalness: 0.35 }),
      crate: pbr({ maps: Tex.crate(), roughness: 0.8 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x3d7068, roughness: 0.6, metalness: 0.1 }),
      terra: new THREE.MeshStandardMaterial({ color: 0xb4644a, roughness: 0.85 }),
      trim: new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.75, metalness: 0.25 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0x11150f, emissive: 0xffedc8, emissiveIntensity: 2.0, roughness: 0.4 }),
      stripe: pbr({ maps: Tex.stripes(), roughness: 0.6 }),
    }
    const geos = { floor: [], wall: [], stoneBase: [], stonePillar: [], doorMetal: [], crate: [], accent: [], terra: [], trim: [], lamp: [], stripe: [] }
    const box = (arr, x, y, z, w, h, d, solid = true) => {
      const geo = new THREE.BoxGeometry(w, h, d)
      geo.translate(x, y + h / 2, z)
      arr.push(geo)
      if (solid) S(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2)
    }
    // 地面贴片（下包区边框 / 标线）：薄盒贴地，y 抬 5mm 防 z-fighting
    const decal = (arr, x, z, w, d) => box(arr, x, 0.005, z, w, 0.012, d, false)

    // ===== 0. 地板 + 四周围墙（6m：灰泥墙身）=====
    const floorGeo = new THREE.BoxGeometry(34, 0.5, 56)
    floorGeo.translate(0, -0.25, -19.5)
    geos.floor.push(floorGeo)
    S(-17, -0.5, -48, 17, 0, 9.5)
    box(geos.wall, 0, 0, 8, 34, 6, 1)       // 北（玩家身后）
    box(geos.wall, 0, 0, -47.5, 34, 6, 1)   // 南（最远处）
    box(geos.wall, -17, 0, -19.5, 1, 6, 56) // 西
    box(geos.wall, 17, 0, -19.5, 1, 6, 56)  // 东

    // 墙面灯带（建筑照明层：北/南各 3 组、东/西各 2 组）
    for (const x of [-10, 0, 10]) {
      box(geos.lamp, x, 5.1, 7.42, 2.6, 0.32, 0.1, false)
      box(geos.lamp, x, 5.1, -46.92, 2.6, 0.32, 0.1, false)
    }
    for (const z of [-10, -30]) {
      box(geos.lamp, -16.42, 5.1, z, 0.1, 0.32, 2.6, false)
      box(geos.lamp, 16.42, 5.1, z, 0.1, 0.32, 2.6, false)
    }

    // 石砌墙基（0.9m、凸出内面 0.18）+ 檐口线脚（5.4m 出挑 0.3）——围墙从
    // "四面平板"变"有基座有收头的立面"；纯装饰不进碰撞（贴墙薄件）
    for (const [x, z, w, d] of [[0, 7.41, 34, 0.18], [0, -46.91, 34, 0.18]]) {
      box(geos.stoneBase, x, 0, z, w, 0.9, d, false)
      box(geos.trim, x, 5.4, z + (z > 0 ? -0.18 : 0.18), w + 0.6, 0.35, 0.36, false)
    }
    for (const sx of [-16.41, 16.41]) {
      box(geos.stoneBase, sx, 0, -19.5, 0.18, 0.9, 56, false)
      box(geos.trim, sx + (sx < 0 ? 0.18 : -0.18), 5.4, -19.5, 0.36, 0.35, 56.6, false)
    }
    // A 点侧墙壁柱（每 8m 一根到顶凸方柱——立面的开间节奏，兼作贴墙掩体）
    for (const z of [2, -6, -14]) {
      box(geos.stonePillar, -16.5, 0, z, 0.6, 6, 0.7)
      box(geos.stonePillar, 16.5, 0, z, 0.6, 6, 0.7)
    }

    // ===== 1. A 门（z=-24 横墙，厚 1.6m + 铆钉钢门套）=====
    const gap = this._side === 'right' ? { x0: 3, x1: 7 } : { x0: -9, x1: -6 }
    const gapCx = (gap.x0 + gap.x1) / 2, gapW = gap.x1 - gap.x0
    const doorFace = -23.2 // 门墙玩家侧面（墙 z∈[-24.8,-23.2]）
    for (const [a, b] of [[-17, gap.x0], [gap.x1, 17]]) {
      box(geos.wall, (a + b) / 2, 0, -24, b - a, 4, 1.6)
      // 檐口收头 + 女儿墙压顶：门墙对天空的剪影（>4.2m 装饰不进碰撞）
      box(geos.trim, (a + b) / 2, 4.0, -24, b - a + 0.4, 0.4, 2.0, false)
      box(geos.wall, (a + b) / 2, 4.4, -24, b - a, 0.45, 0.5, false)
    }
    // 门洞上方封顶砌体（y3.4..4.0 满墙厚）：门楣钢梁只凸在门脸，梁后到墙顶
    // 必须是实墙——否则门顶留 0.6m 镂空缝，透视一穿帮（首轮像素采样抓到）
    box(geos.wall, gapCx, 3.4, -24, gapW, 0.6, 1.6)
    // 门套侧框（凸出玩家侧面 0.35：缺口净宽 x0..x1 不变——Bot 在 z=-30 横移，
    // 门套在其行走带之外；净空几何与旧版完全一致）
    box(geos.doorMetal, gap.x0 - 0.225, 0, doorFace + 0.175, 0.45, 3.4, 0.35)
    box(geos.doorMetal, gap.x1 + 0.225, 0, doorFace + 0.175, 0.45, 3.4, 0.35)
    // 门楣横梁（压顶：缺口上方 y3.4..3.9 的钢梁，门洞净高 3.4m）
    box(geos.doorMetal, gapCx, 3.4, doorFace + 0.175, gapW + 0.9, 0.5, 0.35)
    // 门楣底沿警示条纹（贴钢梁正面下缘，快速识别架枪点位）
    box(geos.stripe, gapCx, 3.42, doorFace + 0.36, gapW + 0.6, 0.12, 0.05, false)
    // 门侧壁灯（暖光箱贴门套外）
    for (const sx of [gap.x0 - 0.85, gap.x1 + 0.85]) {
      box(geos.doorMetal, sx, 2.4, doorFace + 0.05, 0.2, 0.36, 0.14, false)
      box(geos.lamp, sx, 2.4, doorFace + 0.14, 0.12, 0.24, 0.04, false)
    }
    this.gaps = [gap]
    // Bot 横移线（墙后 6m 处——训练不变量）
    this.peekLineZ = -30

    // ===== 2. Main 通道（z -36..-24）：门后纵深 =====
    box(geos.wall, -16.5, 0, -30, 1, 4, 13) // 两侧封口
    box(geos.wall, 16.5, 0, -30, 1, 4, 13)
    for (const z of [-27, -33]) { // 通道壁柱（与 A 点同语言）
      box(geos.stonePillar, -16.4, 0, z, 0.5, 4, 0.7)
      box(geos.stonePillar, 16.4, 0, z, 0.5, 4, 0.7)
    }
    // 通道后墙：整面 + 石基 + 檐口（透过门看到的"通道尽头"）
    box(geos.wall, 0, 0, -36, 34, 4, 0.8)
    box(geos.stoneBase, 0, 0, -35.51, 34, 0.9, 0.18, false)
    box(geos.trim, 0, 4.0, -36, 34.4, 0.35, 1.2, false)
    // 通道箱（按 side 摆在 Bot 行走带对侧：left 缺口 → 带 x∈[-11.4,-3.8]，
    // 箱子放 x>0；right 镜像。透过门看到"通道有掩体"的真实纵深）
    const far = this._side === 'left' ? 1 : -1
    box(geos.crate, 6.5 * far, 0, -33, 1.6, 1.2, 1.6)
    box(geos.crate, 6.8 * far, 1.2, -32.7, 1.6, 1.2, 1.6) // 双箱堆（错位 0.3）
    box(geos.crate, 11.5 * far, 0, -27.5, 1.6, 1.2, 1.6)

    // ===== 3. A 点（玩家区）：下包区标线 + 站点箱阵 =====
    // 下包区（黄黑警示带边框 + 地面 A 字——站点的空间锚点，换位/报点一目了然）
    decal(geos.stripe, 0, -13, 10, 0.3)
    decal(geos.stripe, 0, -19, 10, 0.3)
    decal(geos.stripe, -4.85, -16, 0.3, 6.3)
    decal(geos.stripe, 4.85, -16, 0.3, 6.3)
    // 站点箱阵（单箱 1.2 / 双箱堆 2.4：全部避开 spawn→门视线带与下包区框内）
    const stack = (x, z) => {
      box(geos.crate, x, 0, z, 1.6, 1.2, 1.6)
      box(geos.crate, x + 0.25, 1.2, z - 0.22, 1.6, 1.2, 1.6)
    }
    stack(10, -6)
    stack(-12, -19)
    box(geos.crate, -4.4, 0, -11, 1.6, 1.2, 1.6)
    box(geos.crate, -2, 0, -20.6, 1.6, 1.2, 1.6)
    box(geos.crate, 4.4, 0, -9, 1.6, 1.2, 1.6)
    box(geos.crate, 12, -15, 1.6, 1.2, 1.6)
    box(geos.crate, -13, -8, 1.6, 1.2, 1.6)
    stack(-9.5, -4.5)

    // ===== 4. 远景屋顶天际线（z<-40，玩家不可达：solid=false 省 AABB）=====
    // 陶瓦/灰泥体块 + 檐口——走近 A 门时从 4m 横墙上方渐次露出"城镇"轮廓
    const roof = (x, z, w, h, d, key) => {
      box(geos[key], x, 0, z, w, h, d, false)
      box(geos.trim, x, h, z, w + 0.5, 0.22, d + 0.5, false)
    }
    roof(-9, -42.5, 7, 5.2, 6, 'terra')
    roof(0.5, -44, 9, 6.2, 4.5, 'wall')
    roof(9, -42, 6, 4.8, 5, 'terra')
    roof(-2, -40.8, 4, 4.2, 3, 'wall')

    // ===== 5. 地面距离标线（白色模板漆字，每 10m——练测距/预瞄）=====
    const distMark = (meters, z) => {
      decal(geos.accent, 0, z, 14, 0.14)
      for (const x of [-8.6, 8.6]) {
        const m = this._sign('dist' + meters, 1.7, 0.85, (g, W, H) => {
          g.clearRect(0, 0, W, H)
          g.fillStyle = 'rgba(236,232,225,0.82)'
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

    // ===== 6. 标识系统（无畏契约式定位牌：深绿底白字 + 箭头）=====
    // 门楣牌（A MAIN →）：贴门楣钢梁正面（y 与梁对齐，不悬空于门洞）
    const doorSign = this._sign('doorHeader', 2.6, 0.4, (g, W, H) => {
      g.fillStyle = '#1e3a34'; g.fillRect(0, 0, W, H)
      g.strokeStyle = 'rgba(236,232,225,0.4)'; g.lineWidth = 2; g.strokeRect(5, 5, W - 10, H - 10)
      g.fillStyle = '#ece8e1'
      g.font = `bold ${Math.round(H * 0.52)}px sans-serif`
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText(this._side === 'left' ? '← A MAIN' : 'A MAIN →', W / 2, H / 2)
    })
    doorSign.position.set(gapCx, 3.65, doorFace + 0.36)
    this._placeSign(doorSign)
    // 通道尽头站点定位牌（A）：挂在透过门可见的视线带上（出生点→门中心连线
    // 在后墙的落点附近——左门见 x≈-6.5、右门见 x≈6，牌不躲人）
    const siteSign = this._sign('siteA', 2.2, 2.2, (g, W, H) => {
      g.fillStyle = '#1e3a34'; g.fillRect(0, 0, W, H)
      g.strokeStyle = '#ece8e1'; g.lineWidth = 8; g.strokeRect(12, 12, W - 24, H - 24)
      g.fillStyle = '#ece8e1'
      g.font = `bold ${Math.round(H * 0.58)}px sans-serif`
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText('A', W / 2, H * 0.4)
      g.font = `${Math.round(H * 0.13)}px sans-serif`
      g.fillStyle = 'rgba(236,232,225,0.72)'
      g.fillText('MAIN 通道', W / 2, H * 0.78)
    })
    siteSign.position.set(gapCx + (this._side === 'left' ? 1 : -1), 2.5, -35.55)
    this._placeSign(siteSign)
    // 通道后墙壁灯 ×2（点亮尽头；近门侧一盏落进门视线带）
    for (const sx of [gapCx + 2.5 * (this._side === 'left' ? 1 : -1), -4 * (this._side === 'left' ? 1 : -1)]) {
      box(geos.doorMetal, sx, 2.9, -35.52, 0.2, 0.36, 0.14, false)
      box(geos.lamp, sx, 2.9, -35.44, 0.12, 0.24, 0.04, false)
    }
    // 北墙（玩家身后）：场地主标牌——转身即见
    const board = this._sign('title', 7.2, 1.7, (g, W, H) => {
      g.fillStyle = 'rgba(14,20,26,0.94)'; g.fillRect(0, 0, W, H)
      g.strokeStyle = '#c23b4e'; g.lineWidth = 10; g.strokeRect(8, 8, W - 16, H - 16)
      g.textAlign = 'center'
      g.fillStyle = '#ece8e1'
      g.font = `bold ${Math.round(H * 0.34)}px sans-serif`
      g.fillText('A 点 · 架枪训练场', W / 2, H * 0.42)
      g.fillStyle = 'rgba(236,232,225,0.55)'
      g.font = `${Math.round(H * 0.16)}px sans-serif`
      g.fillText('守 A 门 · 对枪 · 反应', W / 2, H * 0.72)
    })
    board.position.set(0, 4.2, 7.42)
    board.rotation.y = Math.PI // 面向 -z（玩家转身可见）
    this._placeSign(board)

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

  // 标牌落位：静态矩阵 + 挂场景 + 记账（rebuild 统一回收）
  _placeSign(sign) {
    sign.matrixAutoUpdate = false
    sign.updateMatrix()
    this.scene.add(sign)
    this._meshes.push(sign)
  }
}
