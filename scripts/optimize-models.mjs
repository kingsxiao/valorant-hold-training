// 压缩 public/models/ 下的 GLB（对换入的自有模型同样适用）：
//   1. 删除 agent.glb 中未使用的动画 clip（代码只按 /idle|stand|walk|run|sprint/ 匹配）
//   2. dedup/prune/weld：去重、清未引用资源、焊接重复顶点
//      （prune 必须保留空叶子节点：Top_end / IndexTip.R.001 等末端节点
//       是 HandsRig 测量拇指方向、解剖学定尺的标记，删了手部装配会回退）
//   3. resample：按容差抽稀动画关键帧（时长不变，脚步锁相不受影响）
//   4. quantize：几何量化为 KHR_mesh_quantization（three.js GLTFLoader 原生支持，
//      无需额外解码器），POSITION/NORMAL/TEXCOORD/WEIGHTS 从 f32 降到 8~14bit
// 网格/材质/节点名全部保留（程序化贴图按名称分桶，不受影响）。
//
// 用法：node scripts/optimize-models.mjs [glb路径...]   # 缺省处理 public/models/*.glb
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { dedup, prune, weld, quantize, resample } from '@gltf-transform/functions'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const KEEP_ANIM = /idle|stand|walk|run|sprint/i

const io = new NodeIO().registerExtensions([KHRMeshQuantization])

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
  const bytes = await io.writeBinary(doc)
  await writeFile(file, bytes)

  const pct = ((1 - bytes.byteLength / before) * 100).toFixed(0)
  const clipNote = droppedClips ? `，删除未用动画 ${droppedClips} 段` : ''
  console.log(`${basename(file)}: ${mb(before)} → ${mb(bytes.byteLength)}（-${pct}%${clipNote}）`)
}
