// 压缩 public/models/ 下的 GLB（对换入的自有模型同样适用）：
//   1. 删除 agent.glb 中未使用的动画 clip（代码只按 /idle|stand|walk|run|sprint|kamae/
//      匹配；kamae = 无畏契约英雄 GLB 的持枪待机 clip，勿裁）
//   2. dedup/prune/weld：去重、清未引用资源、焊接重复顶点
//      （prune 必须保留空叶子节点：Top_end / IndexTip.R.001 等末端节点
//       是 HandsRig 测量拇指方向、解剖学定尺的标记，删了手部装配会回退）
//   3. resample：按容差抽稀动画关键帧（时长不变，脚步锁相不受影响）
//   4. quantize：几何量化为 KHR_mesh_quantization（three.js GLTFLoader 原生支持，
//      无需额外解码器），POSITION/NORMAL/TEXCOORD/WEIGHTS 从 f32 降到 8~14bit
//   5. 贴图按材质角色再编码（PNG → JPEG/WebP；体积大头，见 reencodeTextures）
// 网格/材质/节点名全部保留（程序化贴图按名称分桶，不受影响）。
//
// 用法：node scripts/optimize-models.mjs [glb路径...]   # 缺省处理 public/models/*.glb
import { NodeIO } from '@gltf-transform/core'
import { EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions'
import { dedup, prune, weld, quantize, resample } from '@gltf-transform/functions'
import sharp from 'sharp'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const KEEP_ANIM = /idle|stand|walk|run|sprint|kamae/i

const io = new NodeIO().registerExtensions([KHRMeshQuantization, EXTTextureWebP])

// 贴图再编码（按材质槽位分类，只动 image/png → 重跑幂等）：
//   normalTexture → JPEG 4:4:4 q92：法线的 RG 是方向数据，不能吃色度抽样
//     （WebP lossy 固定 4:2:0 会扭曲法线）——4:4:4 无抽样，实测 R/G/B
//     PSNR 42~45dB，视觉透明
//   baseColor/emissive → WebP q82（42dB）：比同质量 JPEG 再小 ~30%；
//     EXT_texture_webp 是 three GLTFLoader 原生支持的正式扩展
//   其余（metallicRoughness/occlusion/未链接数据图）→ WebP near-lossless q60
//     （52dB、无色度抽样）——遮罩/参数图不容结构性损伤
//   带 alpha 的贴图 → 无损 WebP：alpha 通道多为发帘/遮罩数据，且暗色毛发
//     纹理的 RGB 噪点在 lossy/near-lossless 下都会被抹平（实测 15~17dB）
//   所有再编码过 PSNR 质量门：<34dB 拒绝换装、保 PNG（防未来换入的
//     高熵纹理被压坏；换取的体积不值得）
const PSNR_FLOOR = 34

async function rgbPsnr(aBytes, bBytes) {
  const A = await sharp(aBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const B = await sharp(bBytes).ensureAlpha().raw().toBuffer()
  let se = 0
  for (let i = 0; i < A.data.length; i += 4)
    for (let c = 0; c < 3; c++) { const d = A.data[i + c] - B[i + c]; se += d * d }
  const mse = se / (A.info.width * A.info.height * 3)
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse)
}

const reencodeTextures = async (doc) => {
  const root = doc.getRoot()
  const role = new Map()
  const mark = (tex, r) => { if (tex && !role.has(tex)) role.set(tex, r) }
  for (const mat of root.listMaterials()) {
    mark(mat.getNormalTexture(), 'normal')
    mark(mat.getBaseColorTexture(), 'color')
    mark(mat.getEmissiveTexture(), 'color')
  }
  let webp = false
  const rows = []
  for (const tex of root.listTextures()) {
    if (tex.getMimeType() !== 'image/png') continue
    const img = tex.getImage()
    if (!img) continue
    const src = Buffer.from(img)
    const r = role.get(tex) ?? 'data'
    const meta = await sharp(src).metadata()
    let out, mime
    if (r === 'normal') {
      out = await sharp(src).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer()
      mime = 'image/jpeg'
    } else if (r === 'color' && !meta.hasAlpha) {
      out = await sharp(src).webp({ quality: 82 }).toBuffer(); mime = 'image/webp'
    } else if (meta.hasAlpha) {
      out = await sharp(src).webp({ lossless: true }).toBuffer(); mime = 'image/webp'
    } else {
      out = await sharp(src).webp({ nearLossless: true, quality: 60 }).toBuffer(); mime = 'image/webp'
    }
    if (out.byteLength >= src.byteLength) continue // 再编码反而更大（小遮罩图常见）→ 保 PNG
    const psnr = await rgbPsnr(src, out)
    if (psnr < PSNR_FLOOR) { // 质量门：压得太狠的（高熵噪点纹理）保原样
      rows.push(`  ${tex.getName() || '?'}[${r}${meta.hasAlpha ? '+a' : ''}] PSNR ${psnr.toFixed(1)}dB < ${PSNR_FLOOR} → 保 PNG`)
      continue
    }
    tex.setImage(out).setMimeType(mime)
    if (mime === 'image/webp') webp = true
    rows.push(`  ${tex.getName() || '?'}[${r}${meta.hasAlpha ? '+a' : ''}] ${(src.byteLength / 1024) | 0}K→${(out.byteLength / 1024) | 0}K  ${psnr.toFixed(0)}dB`)
  }
  if (webp) doc.createExtension(EXTTextureWebP).setRequired(true)
  return rows
}

const args = process.argv.slice(2)
const files = args.length
  ? args
  : (await readdir('public/models'))
      .filter((f) => f.endsWith('.glb'))
      .map((f) => join('public/models', f))

const mb = (n) => (n / 1048576).toFixed(2).padStart(8) + ' MB'

for (const file of files) {
  const before = (await stat(file)).size
  const doc = await io.read(file)

  // agent.glb：裁掉用不到的整段动画（agree/headShake/sad_pose/…）
  let droppedClips = 0
  if (basename(file) === 'agent.glb') {
    for (const anim of doc.getRoot().listAnimations()) {
      if (!KEEP_ANIM.test(anim.getName())) {
        anim.dispose()
        droppedClips++
      }
    }
  }

  await doc.transform(dedup(), prune({ keepLeaves: true }), weld(), resample(), quantize({ quantizeNormal: 12 }))
  const texRows = await reencodeTextures(doc)
  const bytes = await io.writeBinary(doc)
  await writeFile(file, bytes)

  const pct = ((1 - bytes.byteLength / before) * 100).toFixed(0)
  const clipNote = droppedClips ? `，删除未用动画 ${droppedClips} 段` : ''
  console.log(`${basename(file)}: ${mb(before)} → ${mb(bytes.byteLength)}（-${pct}%${clipNote}）`)
  for (const row of texRows) console.log(row)
}
