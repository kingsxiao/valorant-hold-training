把你有权使用的音效文件放进本目录，即可替换内置合成音效（按文件名自动匹配，支持 mp3 / wav / ogg）：

  shot_rifle      Vandal 开枪
  shot_phantom    Phantom 开枪（缺失时回退 shot_rifle）
  shot_pistol     Classic 开枪
  shot_ghost      Ghost 开枪（缺失时回退 shot_pistol）
  shot_handcannon Sheriff 开枪
  shot_knife      刀挥击
  headshot        爆头"叮"声
  kill            击杀确认音
  death           你被击杀
  hurt            受击
  footstep        脚步声（会随机变调播放）
  reload          换弹全程
  empty           空仓击发
  round_start     回合开始

示例：shot_rifle.mp3

注意：
- 本仓库不附带任何游戏原始音频；请仅使用你拥有合法权利的文件（例如自己录制/购买/授权的素材）。
- 文件缺失时自动回退到内置合成音效，不影响运行。
- 想要立体声/位置感：单声道文件配合游戏内 HRTF 定位效果更好。
