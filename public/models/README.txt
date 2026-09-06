把你有权使用的模型文件放进本目录，即可替换内置程序化模型（GLB 格式，文件名固定）：

  agent.glb               训练机器人（假人）外观
                          - Y-up、面向 -Z；自动缩放到总高 1.8m、脚底对地、水平居中
                          - 含 idle/walk/run 动画时按实际移速加权混合（脚步与位移同步）；
                            单动画模型取走路段播放、静止时冻结
                          - 建议单网格或少量网格；命中判定不依赖你的网格几何
                            （固定头/胸/腿球体区域，但会跟随受击后仰/横移侧倾等姿态）

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
                          - 骨架命名兼容清单（GLTFLoader 清洗后：空格→下划线、点删除，
                            如 Hand.R.001 → HandR001；缺任一骨骼则整条路径回退程序化手臂）：
                            手臂链 UpperArmR001/LowerArmR001/HandR001 与
                            UpperArmL/LowerArmL/HandL（.L 侧不带 001），
                            右手食指尖 IndexTipR001（解剖学定尺基准），
                            右手指链 DoubleFingersBeginning001/DoubleFingersR001/
                            DoubleFingersTipR001、IndexBeginningR001/IndexR001/IndexTipR001、
                            ThumbBeginningR001/ThumbR001/ThumbTipR001，
                            左手同名去 001 后缀（如 DoubleFingersBeginning）
                          - 材质命名建议：Glove/Mitt 走深灰战术分支，Hand/Arm/Skin/Face/Body
                            走皮肤分支，其余按布料（详见 src/world/ModelTexturing.js）

  glove.glb               第一人称高精度手套（含 Wrist + 五指三关节骨骼的蒙皮单手模型）
                          - 优先于 hands.glb 使用：双手实例化后逐指贴合握把/护木
                            （每把枪各有收敛握姿，切枪自动重摆）
                          - 删除此文件则回退到 hands.glb / 程序化手臂
                          - 当前内置：J-Toastie "Gloved Hand"（CC-BY 3.0，poly.pizza 分发）
                          - 骨架命名兼容清单（缺任一骨骼则回退 hands.glb 路径）：
                            根：Wrist、Hand、Top_end（拇指末端测量节点）
                            拇指：Thumb/Lower/Middle/Top
                            食指：Index_Finger/Lower001/Middle001/Top001
                            中指：Middle_Finger/Lower002/Middle002/Top002
                            无名指：Ring_Finger/Lower003/Middle003/Top003
                            小指：Pinky/Lower004/Middle004/Top004
                            （也兼容 "Index Finger" 等空格命名，加载时自动清洗）
                          - 模型本体是左手（掌心朝上绑定）：右手实例自动镜像
                          - 材质命名建议：Glove 或裸名 Arm 走深灰战术手套分支，
                            其余按皮肤/布料
                          - 换入模型若无 TEXCOORD_0（贴图不显示）或带逐面法线
                            （表面面片化），运行 DEPLOY.md 附录的两个资产管线脚本

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
