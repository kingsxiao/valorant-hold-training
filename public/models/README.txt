把你有权使用的模型文件放进本目录，即可替换内置程序化模型（GLB 格式，文件名固定）：

  agent.glb       训练机器人（假人）外观
                  - Y-up、面向 -Z；自动缩放到总高 1.8m、脚底对地、水平居中
                  - 建议单网格或少量网格；命中判定与外观无关（头/胸/腿区域固定）

  viewmodel.glb   第一人称持枪模型
                  - -Z 朝前；最大边自动缩放到 0.6m
                  - 加载后替换所有武器（Vandal/Phantom/Sheriff/手枪/刀）外观

  hands.glb       第一人称手臂（含 Hand.L / Hand.R 骨骼的蒙皮模型）
                  - 按骨骼"左手/右手"位置自动对位到枪的握把/护木，手腕下压成持握姿势
                  - 当前内置：J-Toastie "Rigged FPS Arms"（CC-BY 3.0，署名见仓库 README）
                  - 删除此文件则回退到内置程序化手臂

注意：
- 本仓库不附带任何游戏原始模型；请仅使用你拥有合法权利的文件。
- 材质建议 PBR（baseColor/normal/roughnessMetalness），本项目已开启环境反射与 ACES 色调映射。
- 文件缺失时自动使用内置模型，不影响运行。

当前内置资产与来源：
  agent.glb       Mixamo "X Bot" 机器人（经 three.js 官方示例分发，
                  examples/models/gltf/Xbot.glb；动画含 idle/walk/run，
                  训练靶冻结在 idle 站姿）。原 BrainStem 备份为
                  agent.brainstem.bak.glb（Microsoft, CC-BY 4.0），改名即可换回。
  viewmodel.glb   Quaternius AK47（CC0）
  hands.glb       J-Toastie "Rigged FPS Arms"（CC-BY 3.0，poly.pizza 分发）
