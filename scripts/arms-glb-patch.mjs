// 官方 1P 手臂 GLB 补丁（.blend→GLB 之后跑，幂等）：
//   1. MRAE 通道语义修正：Valorant MRAE(R=metal,G=rough,B=AO,A=emissive) 与
//      glTF ORM(G=rough,B=metal) 不一致 → 摘 metallicRoughnessTexture，写死
//      布料参数 metal 0.02 / rough 0.85（法线/漫反射保留——近景质感主要靠 DF+NM）
//   2. AEM 自发光若误挂 → 摘除归零
//   3. KHR_materials_specular/ior 摘除（同源 MRS 误挂，反射染色）
//   4. prune 掉不再引用的贴图
// 用法：node scripts/arms-glb-patch.mjs <src.glb> <out.glb>
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { prune } from '@gltf-transform/functions'
import { stat, writeFile } from 'node:fs/promises'

const [src, out] = process.argv.slice(2)
if (!src || !out) { console.error('usage: node scripts/arms-glb-patch.mjs <src.glb> <out.glb>'); process.exit(1) }

const io = new NodeIO().registerExtensions([KHRMeshQuantization])
const before = (await stat(src)).size
const doc = await io.read(src)

for (const mat of doc.getRoot().listMaterials()) {
  if (mat.getMetallicRoughnessTexture()) {
    mat.setMetallicRoughnessTexture(null)
    mat.setMetallicFactor(0.02)
    mat.setRoughnessFactor(0.85)
    console.log(`  ${mat.getName()}: 摘 MRAE + metal0.02/rough0.85`)
  }
  if (mat.getEmissiveTexture() || mat.getEmissiveFactor().some(v => v > 0)) {
    mat.setEmissiveTexture(null)
    mat.setEmissiveFactor([0, 0, 0])
    console.log(`  ${mat.getName()}: 摘除 AEM 自发光`)
  }
  mat.setExtension('KHR_materials_specular', null)
  mat.setExtension('KHR_materials_ior', null)
}

await doc.transform(prune())
const glb = await io.writeBinary(doc)
await writeFile(out, glb)
const after = (await stat(out)).size
console.log(`${src} -> ${out}: ${(before / 1024 / 1024).toFixed(1)}MB -> ${(after / 1024 / 1024).toFixed(1)}MB`)
