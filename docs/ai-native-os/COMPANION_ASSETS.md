# 伴侣资源：本地配置与公开源码边界

本项目集成 AIRI 默认 Hiyori（Pro）角色方案，不移植完整 AIRI，也不把角色标为原创。AIRI、PixiJS、pixi-live2d-display 的开源许可不覆盖 Live2D 模型或 Cubism Core。

本机演示已配置资源；此次 GitHub 上传只包含集成代码，不再分发下列两个原始资源目录。不配置这些资源时角色显示加载提示，文本/语音/生成 UI 仍可独立使用。

## 克隆后的配置

1. 先阅读并确认自身用途满足 [Live2D 材料协议](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)、[角色条款](https://www.live2d.com/eula/live2d-sample-model-terms_en.html) 和 SDK 随附许可。商业主体和不同用途可能有不同限制。
2. AIRI 参考提交 f166736a760ccf05aafb1388e1833f1237573d8d 的构建配置使用 [Hiyori Pro 中文资源](https://dist.ayaka.moe/live2d-models/hiyori_pro_zh.zip)。下载解压后保留 runtime 和原 ReadMe，放入 apps/desktop/renderer/assets/companion/hiyori_pro_zh/。
3. 从 [Cubism SDK for Web 5-r.3](https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.3.zip) 获取资源；在 apps/desktop/renderer/assets/companion/CubismSdkForWeb-5-r.3/ 中保留 Core/live2dcubismcore.min.js、Core/LICENSE.md、Core/RedistributableFiles.txt 和根 LICENSE.md。
4. 启动 pnpm start，设置 → 虚拟伴侣开启显示。默认缩放为 1；动态可关闭。目录已被 .gitignore 排除，请勿使用 git add -f 上传。

本说明提供来源和集成步骤，不代表所有主体都获准将这些资源重新分发。发布含角色的安装包是单独的许可与发布验收事项。
