# ADR 0055：双语音通路与共享任务运行

日期：2026-09-07。状态：实现及本地协议验证完成；公网语音未验收。

## 目标和边界

用户要求原生音频对话与独立 STT/TTS 两种方式同时存在。原生模式将 WAV 作为 input_audio 直接送入支持音频的模型，取得同一模型的音频和同步文字；禁止偷偷转写为文字后交给文本模型。独立模式明确显示“语音识别 → 文字任务”，识别文字进入草稿，用户确认后发送，朗读是独立按钮。两者均不是持续监听或全双工 Realtime。

## 运行架构

- VoiceService 在 Core 中读 CredentialStore；Renderer 不持有密钥。原生、STT、TTS 独立配置模型、服务和音色，支持 OpenAI 及协议兼容自定义端点。
- 设置真实测试使用固定合成静音/文字，不访问麦克风。原生模式同时验证音频响应和函数调用；模型、音色、端点或密钥变更使验证失效。测试可能计费，失败不自动换模型。
- NativeVoiceRuntime 实现 AgentRuntime，不创建第二个 Main 或对话数据库。任务的 host-owned runtimeBinding 决定本次运行时/模型，保持 Agent 默认文本引擎不变，继承其提供商/隐私策略。普通模型能力约束仍生效。
- 原生任务进入原 Scheduler/RuntimeManager；xiling_os 工具由宿主权限边界执行。ui.present 产生受信组件；提交表单回到同一 Task 并保留 runtimeBinding。没有模型生成代码执行。
- 输入 WAV 和回复 WAV 作为本地音频 Artifact 保存；回复同步文字进入 Session。音频产物可播放，不作为 base64 文字预览。当前音频产物暂不提供文件导出按钮。
- 上下文编译使用既有任务/会话接口；原生音频历史仅取同会话最近两次已完成原生任务，音频以模态附件发送，不混入文本提示。音频计费不等同文本 token 估算，当前未实现精确音频费用账本。

## 交互和资源

Chat 与伴侣共用语音组件。点击说话才请求音频权限，禁止视频请求；最长 60 秒，停止后发送。采样为 24kHz 单声道 PCM WAV（只做音频编码，不转成文本）。单个麦克风所有者，识别/合成有请求取消，原生任务使用内核取消；会话切换/组件关闭清理录音、订阅并阻止过期回复播放。

全局单一播放器提供静音、停止、暂停/继续。伴侣嘴型来自真实播放音量，不另开语音 Agent。角色懒加载并限制帧率，不放宽 CSP。录音属于用户本地会话数据，提交时上传到所选提供商；不上传 GitHub。

HTTP 仅允许本机开发端点，外部要求 HTTPS；拒绝重定向、嵌入 URL 凭据。请求超时 90 秒，音频负载有大小限制，原生工具最多 8 轮。不是任意提供商自动适配器：不兼容协议或原生模态的模型会被禁用。

## 验证与限制

voice.test.ts 使用本地 HTTP fixture 验证：原生音频 → 生成表单 → 同任务续跑 → 音频产物；独立 STT/TTS；原生不调用 TTS；主 Agent 文本引擎不被修改；密钥改变后禁用；无效音频拒绝。
本地协议测试不能证明真人录音、提供商配额/模型权限、端到端声音质量或 Windows/macOS 打包授权均已验收。签名打包时应配置 macOS NSMicrophoneUsageDescription；当前使用开发 Electron 宿主。

接口依据：[Audio guide](https://developers.openai.com/api/docs/guides/audio)、[Audio API](https://developers.openai.com/api/reference/resources/audio)。未来 Realtime/WebRTC 应使用独立适配器，不能将本轮方案改名冒充实时双工。
