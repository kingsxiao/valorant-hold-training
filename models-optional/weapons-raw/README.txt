无畏契约武器几何体原始件（非官方游戏提取资源，无再分发授权，仅本机个人使用）

来源：github.com/yseho031018/codex-vibe-fps（Godot 项目 assets/models/weapons/）
状态：纯网格 Blender 导出（POSITION+NORMAL），无 UV、无贴图、单材质灰金属。
      12-100 万三角面。直接当 viewmodel 用会是无纹理灰块 —— 需先进 Blender
      做 UV 展开 + 贴图烘焙（models-resource 有同源 .psk+.tga 全套贴图可参照），
      再走 npm run optimize:models 压缩管线。

  Vandal.glb 9.6M 120k tris   Operator.glb 9.4M 118k   Odin.glb 13.5M 216k
  Bucky.glb 10M 126k          Classic_Pistol.glb 14M（100 万面，需减面）
  Nife.glb 5.9M 74k
