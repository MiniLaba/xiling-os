# ADR 0050：按任务解析所选模型凭据

状态：接受，2026-09-05。

后续修订（批次 9）：custom 已接入 HTTP(S) baseUrl 和 openai-completions/openai-responses；禁止 URL 内凭据、查询参数、片段。配置文件只含 apiKeyEnv 引用；自定义无密钥使用 xiling-local 作为适配器所需占位值。下方“custom 拒绝”是历史状态。未知提供商仍拒绝，未进行真实端点交付验收。

核心进程初始化现有 CredentialStore，将只读回调注入宿主。每次创建 Harness 时按任务解析后的提供商读取最新 API Key，密钥不存入领域事件、App 包或模型策略。保存/清除凭据作用于下一次执行，已开始任务不会中途换密钥。

子进程环境采用基础启动变量白名单，加上单个提供商的标准 API Key 变量，不继承其他模型、NASA 等账户密钥或 NODE_OPTIONS。错误展示替换该次密钥原文。仍保留 HOME 供运行程序使用，因此这不是文件系统沙箱，也不保证第三方运行程序不会自行读取主目录配置。

当前映射 OpenAI、Anthropic、Google、OpenRouter、DeepSeek（含 deepseek-official 别名）、xAI、Groq。映射只证明凭据传输；实际 DSH provider 插件必须配置为消费相同环境变量，尚无完整组合的真实验收。custom 和未识别提供商显式拒绝，后续通过端点配置桥接入，不静默更改 provider 或模型。

只新增一项凭据桥定向测试，覆盖所选密钥、轮次更新、错误脱敏、环境隔离及缺失/不支持失败。没有进行真实模型网络调用；P1 仍进行中。
