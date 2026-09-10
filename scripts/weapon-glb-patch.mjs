// 武器官方 GLB 补丁（.blend→GLB 之后跑，或对已上线 GLB 幂等重跑）：
//   1. MRS 通道修正：Valorant 的 MRS 贴图语义与 glTF ORM 不一致 → 全金属全粗糙
//      （黑剪影）。摘 metallicRoughnessTexture、写死 metal 0.3/rough 0.5（法线保留）。
//      玻璃件（低粗糙透明）跳过。
//   2. AEM 自发光修正：AEM（红通道=环境遮罩响应）若被接到 emissive 且
//      emissiveFactor[1,1,1] → 整枪自发光（默认皮肤曾整枪橘红/泛白）。摘除归零。
//   3. KHR_materials_specular/ior 摘除（同源 MRS 误挂，反射染色）。
//   4. Tritium 氚光瞄具还原（Phantom）：导出成 alpha=0+MASK 不可见 → OPAQUE +
//      绿色自发光（官方默认武器瞄具氚光小绿点）。
//   5. --flip-y：场景子节点包一层 180° 绕 Y 旋转（作者系枪口 +X → 对齐 -X 约定；
//      几何不动只转节点，蒙皮/绑定安全）。
//   6. prune 掉不再引用的贴图。
// 用法：node scripts/weapon-glb-patch.mjs <src.glb> <out.glb> [--flip-y]
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { prune } from '@gltf-transform/functions'
import { stat, writeFile } from 'node:fs/promises'

const [src, out, ...flags] = process.argv.slice(2)
if (!src || !out) { console.error('usage: node scripts/weapon-glb-patch.mjs <src.glb> <out.glb> [--flip-y]'); process.exit(1) }

const io = new NodeIO().registerExtensions([KHRMeshQuantization])
const before = (await stat(src)).size
const doc = await io.read(src)

const isGlass = (mat) => mat.getAlphaMode() === 'BLEND' && mat.getRoughnessFactor() < 0.1

for (const mat of doc.getRoot().listMaterials()) {
  if (/tritium/i.test(mat.getName())) {
    mat.setAlphaMode('OPAQUE')
    mat.setBaseColorFactor([0.05, 0.05, 0.05, 1])
    mat.setEmissiveFactor([0.1, 0.95, 0.35])
    console.log(`  ${mat.getName()}: 氚光瞄具还原（OPAQUE + 绿色自发光）`)
    continue
  }
  if (isGlass(mat)) {
    // 玻璃件正常应在 blend2glb 阶段已删（官方 Vandal 系无光学件；皮肤移植件的
    // 悬浮玻璃盘是错误分层）。漏网到此则保留原样（透明玻璃不抢戏）
    console.log(`  ${mat.getName()}: 玻璃件保留（BLEND/低粗糙）`)
  } else {
    if (mat.getMetallicRoughnessTexture()) {
      mat.setMetallicRoughnessTexture(null)
      mat.setMetallicFactor(0.3)
      mat.setRoughnessFactor(0.5)
      console.log(`  ${mat.getName()}: 摘 MRS + metal0.3/rough0.5`)
    }
    if (mat.getEmissiveTexture() || mat.getEmissiveFactor().some(v => v > 0)) {
      mat.setEmissiveTexture(null)
      mat.setEmissiveFactor([0, 0, 0])
      console.log(`  ${mat.getName()}: 摘除 AEM 自发光`)
    }
  }
  mat.setExtension('KHR_materials_specular', null)
  mat.setExtension('KHR_materials_ior', null)
}

if (flags.includes('--flip-y')) {
  const root = doc.getRoot()
  const scene = root.listScenes()[0]
  const wrapper = doc.createNode('muzzle_flip').setRotation([0, 1, 0, 0]) // XYZW: 180° 绕 Y
  for (const child of scene.listChildren().slice()) wrapper.addChild(child)
  scene.addChild(wrapper)
  console.log('  根节点包 180° 绕 Y 旋转（枪口 +X → -X）')
}

await doc.transform(prune())
const bytes = await io.writeBinary(doc)
await writeFile(out, bytes)
const mb = (n) => (n / 1048576).toFixed(2) + ' MB'
console.log(`${out}: ${mb(before)} → ${mb(bytes.byteLength)}`)
