// 技能道具官方 GLB 补丁（.blend→GLB 之后跑）：
//   1. MRS 通道语义修正：Valorant 的 MRAE 贴图若被 Blender 接到 metallicRoughness
//      输入，glTF 语义不一致 → 全金属全粗糙（黑剪影）。摘掉 metallicRoughnessTexture、
//      写死 metallic 0.3 / roughness 0.5（法线贴图保留）。
//   2. 贴图重编码压缩（基色/法线 1024 JPEG、其余 512）。
//   3. dedup/prune(keepLeaves)/weld/quantize（蒙皮网格安全）。
// 用法：node scripts/ability-glb-patch.mjs <src.glb> <out.glb>
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { dedup, prune, weld, quantize, textureCompress } from '@gltf-transform/functions'
import sharp from 'sharp'
import { stat, writeFile } from 'node:fs/promises'

const [src, out] = process.argv.slice(2)
if (!src || !out) { console.error('usage: node scripts/ability-glb-patch.mjs <src.glb> <out.glb>'); process.exit(1) }

const io = new NodeIO().registerExtensions([KHRMeshQuantization])
const before = (await stat(src)).size
const doc = await io.read(src)

let stripped = 0
for (const mat of doc.getRoot().listMaterials()) {
  if (mat.getMetallicRoughnessTexture()) { mat.setMetallicRoughnessTexture(null); stripped++ }
  mat.setMetallicFactor(0.3)
  mat.setRoughnessFactor(0.5)
  // 贴图命名给 textureCompress 的 pattern 分类（基色 bc / 法线 nrm / 其余 tex）
  let i = 0
  for (const [tex, tag] of [
    [mat.getBaseColorTexture(), 'bc'],
    [mat.getNormalTexture(), 'nrm'],
    [mat.getOcclusionTexture(), 'tex'],
    [mat.getEmissiveTexture(), 'tex'],
  ]) {
    if (tex && !tex.getName()) tex.setName(`${tag}_${i++}`)
  }
}

await doc.transform(
  dedup(),
  prune({ keepLeaves: true }),
  weld(),
  quantize({ quantizeNormal: 12 }),
  textureCompress({ encoder: sharp, pattern: /^bc/, targetFormat: 'jpeg', resize: [1024, 1024], quality: 88 }),
  textureCompress({ encoder: sharp, pattern: /^nrm/, targetFormat: 'jpeg', resize: [1024, 1024], quality: 95 }),
  textureCompress({ encoder: sharp, pattern: /^tex/, targetFormat: 'jpeg', resize: [512, 512], quality: 90 }),
)

const bytes = await io.writeBinary(doc)
await writeFile(out, bytes)
const mb = (n) => (n / 1048576).toFixed(2) + ' MB'
console.log(`${out}: ${mb(before)} → ${mb(bytes.byteLength)}（-${((1 - bytes.byteLength / before) * 100).toFixed(0)}%，摘 MRT×${stripped}）`)
