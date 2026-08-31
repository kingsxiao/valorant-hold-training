import * as THREE from 'three'
import { Tex } from './Textures.js'

// ============================================================================
// GLB 模型贴图器：给用户/内置 GLB（agent / viewmodel / hands）赋程序化 PBR 贴图。
// 这些 GLB（X Bot / Quaternius AK47 / J-Toastie FPS Arms）都是纯色白模；
// 按材质名与底色识别用途 → 套用 Textures.js 的贴图（颜色/粗糙度/法线），
// 保持"全部程序化生成、无外部素材"的路线。纹理对象为全局单例，直接共享引用。
// 无 UV 的模型（Quaternius 低模常见）用盒式投影按包围盒生成 UV，
// 以根节点包围盒为基准投影 → 各零件贴图密度一致。
// ============================================================================

// 把贴图组赋到材质上；tint 为 null 表示保留原色
function assign(mat, maps, { tint = null, roughness = null, metalness = null, normalScale = 1 } = {}) {
  if (maps.map) mat.map = maps.map
  if (maps.roughnessMap) mat.roughnessMap = maps.roughnessMap
  if (maps.normalMap) {
    mat.normalMap = maps.normalMap
    mat.normalScale = new THREE.Vector2(normalScale, normalScale)
  }
  if (tint !== null) mat.color.set(tint)
  if (roughness !== null) mat.roughness = roughness
  if (metalness !== null) mat.metalness = metalness
  mat.needsUpdate = true
}

// 提亮暗色 tint：白模材质多为深灰（lum 0.05~0.25），乘上贴图会糊成黑团；
// 按亮度映射到 [floor, ceil] 区间并保持原有明暗排序
function liftedTint(color, floor = 0.42, ceil = 0.88) {
  const lum = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
  const target = Math.min(ceil, floor + Math.min(lum, 0.3) * 1.5)
  const k = target / Math.max(lum, 1e-4)
  return new THREE.Color(
    Math.min(1, color.r * k), Math.min(1, color.g * k), Math.min(1, color.b * k),
  )
}

// 盒式投影 UV：按顶点法线主轴投影到根包围盒的两个轴向平面。
// 只补缺失的 uv（已有 UV 的模型用作者自己的展开）；蒙皮网格跳过（矩阵随骨骼变）
export function boxProjectUVs(root, tiles = 6) {
  root.updateMatrixWorld(true)
  const bb = new THREE.Box3().setFromObject(root)
  const size = bb.getSize(new THREE.Vector3())
  const k = tiles / Math.max(size.x, size.y, size.z, 1e-4)
  const c = bb.getCenter(new THREE.Vector3())
  const p = new THREE.Vector3()
  root.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh || o.geometry.attributes.uv) return
    const geo = o.geometry
    const pos = geo.attributes.position
    if (!geo.attributes.normal) geo.computeVertexNormals()
    const nor = geo.attributes.normal
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)
      const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i))
      let u, v
      if (ax >= ay && ax >= az) { u = (p.z - c.z) * k; v = (p.y - c.y) * k }
      else if (ay >= az) { u = (p.x - c.x) * k; v = (p.z - c.z) * k }
      else { u = (p.x - c.x) * k; v = (p.y - c.y) * k }
      uv[i * 2] = u
      uv[i * 2 + 1] = v
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  })
}

const eachMat = (root, fn) => root.traverse(o => {
  if (!o.isMesh) return
  const mats = Array.isArray(o.material) ? o.material : [o.material]
  mats.forEach(fn)
})

// ---- 训练假人（agent.glb，如 Mixamo X Bot）：关节深色橡胶 + 外壳装甲板 ----
// 贴图本身已烤漆上色（暖白板 + 敌方识别红橙板），材质 tint 置白
export function applyAgentTextures(root) {
  eachMat(root, m => {
    if (!m.isMeshStandardMaterial) return
    if (/joint|gum|rubber|tire|sole/i.test(m.name)) {
      assign(m, Tex.robotJoint(), { tint: 0xffffff, roughness: 0.72, metalness: 0.2, normalScale: 1.1 })
    } else {
      assign(m, Tex.robotShell(), { tint: 0xffffff, roughness: 0.5, metalness: 0.3 })
    }
  })
}

// ---- 第一人称枪模（viewmodel.glb，如 Quaternius AK47）：无 UV 时盒式投影 ----
// 材质名带 wood → 木纹；dark/black → 深色金属；其余 → 枪械钢。暗色 tint 提亮防糊黑
export function applyViewmodelTextures(root) {
  boxProjectUVs(root, 6)
  eachMat(root, m => {
    if (!m.isMeshStandardMaterial) return
    const tint = liftedTint(m.color)
    if (/wood/i.test(m.name)) {
      assign(m, Tex.wood(), { tint: 0xd2a878, roughness: 0.55, metalness: 0.05, normalScale: 0.8 })
    } else if (/dark|black|graphite/i.test(m.name)) {
      assign(m, Tex.metal(), { tint, roughness: 0.5, metalness: 0.7, normalScale: 0.8 })
    } else {
      assign(m, Tex.metal(), { tint, roughness: 0.42, metalness: 0.8, normalScale: 0.8 })
    }
  })
}

// ---- 第一人称手臂（hands.glb，如 J-Toastie Rigged FPS Arms）----
// 袖臂 → 战术布料（保留原色 tint）；皮肤 → 皮肤贴图；手套 → 聚合物橘皮纹
export function applyHandsTextures(root) {
  eachMat(root, m => {
    if (!m.isMeshStandardMaterial) return
    if (/glove|mitt/i.test(m.name)) {
      assign(m, Tex.polymer(), { tint: liftedTint(m.color, 0.4, 0.75), roughness: 0.88, metalness: 0.05, normalScale: 1.4 })
    } else if (/skin|face|body/i.test(m.name)) {
      assign(m, Tex.skin(), { roughness: 0.62, metalness: 0, normalScale: 0.8 })
    } else {
      assign(m, Tex.fabric(), { tint: liftedTint(m.color, 0.2, 0.45), roughness: 0.9, metalness: 0, normalScale: 1.0 })
    }
  })
}
