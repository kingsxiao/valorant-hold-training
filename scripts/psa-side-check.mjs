// 解析级确认横移侧别映射：FK 官方曲线（locomotion.json）到 mesh 空间，
// 比较盆骨→脚的水平方向在 N / E / W 三套循环里的平均偏摆角。
// 若 E 片的脚整体偏向 mesh +X（模型右）→ Bot._strafeSide 的「E=lx>0」映射正确；
// 偏向 -X → 映射反了需交换。
// FK 链：GLB 节点 TRS（_rootJoint→Skeleton→Root→Splitter→Pelvis，无动画轨道，
// 恒为 node TRS）+ JSON 轨道（Splitter/Pelvis q&p、L/R_Hip、L/R_Knee、L/R_Foot q）
import fs from 'node:fs'
import * as THREE from 'three'

const loco = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))

// GLB 关节 rest TRS（joint 名 → {t, q}）
function glbJoints(file) {
  const buf = fs.readFileSync('public/models/' + file)
  const jl = buf.readUInt32LE(12)
  const j = JSON.parse(buf.slice(20, 20 + jl).toString())
  const out = {}
  for (const i of j.skins[0].joints) {
    const n = j.nodes[i]
    if (n.name) out[n.name] = { t: n.translation ?? [0, 0, 0], q: n.rotation ?? [0, 0, 0, 1], p: n.parent }
  }
  return out
}

// 骨链解析（去 _NNNN 后缀）
function buildRig(joints) {
  const byPlain = new Map(Object.keys(joints).map(n => [n.replace(/_\d+$/, ''), n]))
  const pick = (plain) => joints[byPlain.get(plain)]
  return { pick }
}

// 髋骨 mesh 空间旋转的周期均值（四元数分量平均后归一）。腿链偏摆（横移时
// 「腿链朝移动方向 yaw」）是旋转量——位置均值会被摆动的对称性洗掉。
function meanQ(rig, clip, bone) {
  const n = clip.times.length
  const acc = [0, 0, 0, 0]
  for (let f = 0; f < n; f++) {
    // Q_hip_mesh = Q_pelvisMesh · Q_hipLocal（fkFrame 已算好链到盆骨的矩阵）
    const pelvisM = pelvisMatrix(rig, clip, f)
    const node = rig.pick(bone)
    const tr = clip.tracks.find(t => t.b === bone)
    const lq = new THREE.Quaternion(...(tr ? tr.q.slice(f * 4, f * 4 + 4) : node.q))
    const qm = new THREE.Quaternion().setFromRotationMatrix(pelvisM).multiply(lq)
    // 半球对齐到首帧防平均抵消
    if (f === 0) _ref0Cache.copy(qm)
    if (qm.dot(_ref0Cache) < 0) qm.set(-qm.x, -qm.y, -qm.z, -qm.w)
    acc[0] += qm.x; acc[1] += qm.y; acc[2] += qm.z; acc[3] += qm.w
  }
  const nrm = Math.hypot(...acc)
  return new THREE.Quaternion(acc[0] / nrm, acc[1] / nrm, acc[2] / nrm, acc[3] / nrm)
}
const _ref0Cache = new THREE.Quaternion()

// 两个循环均值的差（rotvec，度）：正 Y = R_y(+θ)（mesh 前方 -Z 转向 -X 即模型左）
function deltaDeg(qa, qb) {
  const d = qa.clone().multiply(qb.clone().invert())
  const ang = 2 * Math.acos(Math.min(1, Math.abs(d.w))) * 180 / Math.PI
  const n = Math.hypot(d.x, d.y, d.z) || 1
  return { ang, x: d.x / n, y: d.y / n, z: d.z / n }
}

function pelvisMatrix(rig, clip, fi) {
  const q = (bone) => { const tr = clip.tracks.find(t => t.b === bone); return tr ? tr.q.slice(fi * 4, fi * 4 + 4) : null }
  const p = (bone) => { const tr = clip.tracks.find(t => t.b === bone); return tr?.p ? tr.p.slice(fi * 3, fi * 3 + 3) : null }
  let acc = new THREE.Matrix4()
  for (const plain of ['Skeleton', 'Root', 'Splitter', 'Pelvis']) {
    const node = rig.pick(plain)
    const has = plain === 'Splitter' || plain === 'Pelvis'
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...(has ? (p(plain) ?? node.t) : node.t)),
      new THREE.Quaternion(...(has ? (q(plain) ?? node.q) : node.q)),
      new THREE.Vector3(1, 1, 1),
    )
    acc = acc.clone().multiply(m)
  }
  return acc
}

for (const [glb, hero] of [['agent-sova.glb', 'sova'], ['agent-jett.glb', 'jett']]) {
  const rig = buildRig(glbJoints(glb))
  console.log(`== ${hero}（GLB ${glb}）==`)
  const sets = hero === 'sova' ? loco.sova : loco.jett
  {
    // 逐帧盆骨前向水平角（对角度统计，不对四元数平均——大幅度摆动下分量平均有半球陷阱）
    const yawStats = (clip) => {
      const n = clip.times.length
      const yaws = []
      for (let f = 0; f < n; f++) {
        const q = new THREE.Quaternion().setFromRotationMatrix(pelvisMatrix(rig, clip, f))
        const v = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
        yaws.push(Math.atan2(v.x, -v.z) * 180 / Math.PI)
      }
      const mean = yaws.reduce((a, b) => a + b, 0) / n
      return { mean: +mean.toFixed(1), min: +Math.min(...yaws).toFixed(1), max: +Math.max(...yaws).toFixed(1) }
    }
    const n = yawStats(sets.runN), e = yawStats(loco.strafe.runE), w = yawStats(loco.strafe.runW)
    console.log(`  Pelvis 逐帧前向水平角：N mean=${n.mean}° [${n.min},${n.max}]  E mean=${e.mean}° [${e.min},${e.max}]  W mean=${w.mean}° [${w.min},${w.max}]`)
    console.log(`    （正=盆骨前缘朝 mesh +X 模型右；E−N=${(e.mean-n.mean).toFixed(1)}°  W−N=${(w.mean-n.mean).toFixed(1)}°）`)
  }
  {
    const qn = meanQ(rig, sets.runN, 'Pelvis')
    const qe = meanQ(rig, loco.strafe.runE, 'Pelvis')
    const qw = meanQ(rig, loco.strafe.runW, 'Pelvis')
    const de = deltaDeg(qe, qn), dw = deltaDeg(qw, qn)
    console.log(`  Pelvis 盆骨 mesh 旋转均值差：`)
    console.log(`    E−N: ${de.ang.toFixed(1)}° 轴=(${de.x.toFixed(2)},${de.y.toFixed(2)},${de.z.toFixed(2)})   W−N: ${dw.ang.toFixed(1)}° 轴=(${dw.x.toFixed(2)},${dw.y.toFixed(2)},${dw.z.toFixed(2)})`)
    console.log(`    Y 分量：E=${(de.y*de.ang).toFixed(1)}°  W=${(dw.y*dw.ang).toFixed(1)}°（负=盆骨前缘转向 mesh +X 模型右）`)
  }
  for (const side of ['L', 'R']) {
    const qn = meanQ(rig, sets.runN, `${side}_Hip`)
    const qe = meanQ(rig, loco.strafe.runE, `${side}_Hip`)
    const qw = meanQ(rig, loco.strafe.runW, `${side}_Hip`)
    const de = deltaDeg(qe, qn), dw = deltaDeg(qw, qn)
    console.log(`  ${side}_Hip 髋 mesh 旋转均值差：`)
    console.log(`    E−N: {ang}° 轴=({x:+.2f},{y:+.2f},{z:+.2f})  W−N: {ang2}° 轴=({x2:+.2f},{y2:+.2f},{z2:+.2f})`
      .replace('{ang}', de.ang.toFixed(1)).replace('{ang2}', dw.ang.toFixed(1))
      .replace('{x:+.2f}', de.x.toFixed(2)).replace('{y:+.2f}', de.y.toFixed(2)).replace('{z:+.2f}', de.z.toFixed(2))
      .replace('{x2:+.2f}', dw.x.toFixed(2)).replace('{y2:+.2f}', dw.y.toFixed(2)).replace('{z2:+.2f}', dw.z.toFixed(2)))
    console.log(`    Y 轴分量：E=${(de.y * de.ang).toFixed(1)}°  W=${(dw.y * dw.ang).toFixed(1)}°（正=腿前方转向模型左 -X，负=转向模型右 +X）`)
  }
}
