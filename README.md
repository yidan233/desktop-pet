# 没有特色 · 桌宠

多只二次元桌宠同时在桌面上走动、睡觉、被拖拽,并且会互相打招呼、追逐、一起合影。

## 运行
需要 Node.js 18+。
```
npm install
npm start
```
- 托盘图标(右下角)点击 / 右键桌宠:合影、聚一聚、添加桌宠、大小、开机自启、退出。
- 左键拖拽:拎起桌宠,松手后会掉下来;掉在另一只旁边会触发联动。
- 左键单击:打招呼;双击:招牌动作(Sunny = 举盾牌)。
- 透明区域鼠标会穿透到桌面,只有点到角色身上才会响应。

## 打包成可执行文件
- Windows(在 Windows 上):`npm run dist:win` → `dist/DesktopPets-版本-win-x64.exe`(安装包)和 `DesktopPets-版本-portable.exe`(免安装,双击即用)。
- macOS(必须在 Mac 上):`npm run dist:mac` → `dist/*.dmg`(Intel 和 Apple Silicon 各一个)和 `.zip`。
- 没有两台电脑:把整个文件夹推到 GitHub,打 tag(如 `git tag v0.2.1 && git push --tags`)或在 Actions 页面手动运行 "release",构建完成后自动发布到 Releases,Windows 和 Mac 的安装包会一起构建,在页面底部 Artifacts 下载。
- Mac 版没有苹果开发者签名,首次打开请:右键 App → 打开;或终端执行 `xattr -cr /Applications/没有特色.app`。Windows 可能弹 SmartScreen,点"更多信息 → 仍要运行"。

## 测试
- `npm test`:行为逻辑(随机多种子长时间模拟、拖拽联动、合影)。
- 端到端(需要 Linux + xvfb):`PET_SELFTEST=1 xvfb-run -a npx electron . --no-sandbox --disable-gpu`

## 添加新角色
1. 把 15 姿势精灵表(3 行 × 5 列,纯白背景)切成透明帧:
   `python3 tools/slice_sheet.py 精灵表.png assets/pets/<id> "yawn,sleep,wave,point,wave_high,p6,wave_happy,surprise,think,peace,walk_a,laugh,p13,p14,walk_b"`
   (需要 `pip install pillow numpy scipy`;脚本会在输出目录生成 15 张 PNG 和 `_preview_dark.png` 预览)
2. 复制 `assets/pets/sunny/pet.json` 到新目录,改 id、name、frames 文件名、anim 动画映射和 lines 台词。
3. 重新启动,新角色会自动出现在"添加桌宠"菜单里。

## 结构
- `renderer/brain.js`:世界和状态机(待机/行走/睡觉/拖拽/掉落/打招呼/追逐/合影),纯逻辑。
- `renderer/renderer.js`:canvas 渲染、气泡、像素级命中检测、鼠标事件。
- `main.js`:透明置顶窗口、托盘、菜单、偏好保存。
