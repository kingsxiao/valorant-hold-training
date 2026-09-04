把你有权使用的模型文件放进本目录，即可替换内置程序化模型（GLB 格式，文件名固定）：

  agent.glb               训练机器人（假人）外观
                          - Y-up、面向 -Z；自动缩放到总高 1.8m、脚底对地、水平居中
                          - 含 idle/walk/run 动画时按实际移速加权混合（脚步与位移同步）；
                            单动画模型取走路段播放、静止时冻结
                          - 建议单网格或少量网格；命中判定与外观无关（头/胸/腿区域固定）

  viewmodel-vandal.glb    Vandal 第一人称持枪模型（经典 AKM 木质造型）
  viewmodel-phantom.glb   Phantom 第一人称持枪模型（战术导轨 + 消音器造型）
                          - 作者系枪管沿 -X（-X=枪口、+Y 上、-Z 射手右侧）；
                            运行时自动归一到 0.85m 并在作者系内居中
                          - 带真实 PBR 贴图的模型原生材质直接保留；
                            无贴图白模回退程序化盒式投影 + 材质
                          - 模型自带名为 bolt carrier 的节点会绑成击发后坐机件
                            （Phantom 内置即用）；无命名机件则补程序化拉机柄
                          - 旧版单文件 viewmodel.glb 仍支持（两把步枪共用，作回退）

  hands.glb               第一人称手臂（含 Hand.L / Hand.R 骨骼的蒙皮模型）
                          - 按骨骼"左手/右手"位置自动对位到枪的握把/护木，手腕下压成持握姿势
                          - 仅随步枪（Vandal/Phantom）显隐；手枪/刀使用内置程序化手臂
                          - 当前内置：J-Toastie "Rigged FPS Arms"（CC-BY 3.0，署名见仓库 README）
                          - 删除此文件则回退到内置程序化手臂

  glove.glb               第一人称高精度手套（含 Wrist + 五指三关节骨骼的蒙皮单手模型）
                          - 优先于 hands.glb 使用：双手实例化后逐指贴合握把/护木
                            （每把枪各有收敛握姿，切枪自动重摆）
                          - 删除此文件则回退到 hands.glb / 程序化手臂
                          - 当前内置：J-Toastie "Gloved Hand"（CC-BY 3.0，poly.pizza 分发）

注意：
- 本仓库不附带任何游戏原始模型；请仅使用你拥有合法权利的文件。
- 材料建议 PBR（baseColor/normal/roughnessMetalness），本项目已开启环境反射与 ACES 色调映射。
- 文件缺失时自动使用内置模型，不影响运行。

当前内置资产与来源（CC-BY 作品请保留署名）：
  agent.glb               Mixamo "X Bot" 机器人（经 three.js 官方示例分发，
                          examples/models/gltf/Xbot.glb；动画含 idle/walk/run，
                          训练靶按实际移速混合播放）。原 BrainStem 备份为
                          models-optional/agent.brainstem.bak.glb（Microsoft, CC-BY 4.0）。
  viewmodel-vandal.glb    "AK-47 Kalashnikov" by Mateusz Woliński
                          （Sketchfab，CC-BY 4.0；经 Objaverse 分发，几何量化 +
                          贴图 JPEG 重编码，2026-09-04）
  viewmodel-phantom.glb   "AK 47 Tactical Upgrade" by Mateusz Woliński
                          （Sketchfab，CC-BY 4.0；经 Objaverse 分发，同上压缩管线）
  hands.glb               J-Toastie "Rigged FPS Arms"（CC-BY 3.0，poly.pizza 分发）
  glove.glb               J-Toastie "Gloved Hand"（CC-BY 3.0，poly.pizza 分发）
  （旧版 viewmodel.glb = Quaternius AK47，CC0，备份为
   models-optional/viewmodel.quaternius.bak.glb）
