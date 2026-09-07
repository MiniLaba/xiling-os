/** Only the selected model credential crosses the process boundary. */
const providerKeys: Record<string, { storeId: string; variable: string }> = {
  openai: { storeId: "openai", variable: "OPENAI_API_KEY" },
  anthropic: { storeId: "anthropic", variable: "ANTHROPIC_API_KEY" },
  google: { storeId: "google", variable: "GEMINI_API_KEY" },
  openrouter: { storeId: "openrouter", variable: "OPENROUTER_API_KEY" },
  deepseek: { storeId: "deepseek", variable: "DEEPSEEK_API_KEY" },
  "deepseek-official": { storeId: "deepseek", variable: "DEEPSEEK_API_KEY" },
  xai: { storeId: "xai", variable: "XAI_API_KEY" },
  groq: { storeId: "groq", variable: "GROQ_API_KEY" },
};

export function harnessCredentials(provider: string | undefined, read: (provider: string, field?: string) => string | undefined,
  parent: Record<string, string | undefined>) {
  const custom = provider === "custom";
  const binding = custom ? { storeId: "custom", variable: "XILING_CUSTOM_API_KEY" } :
    provider === undefined || !Object.hasOwn(providerKeys, provider) ? undefined : providerKeys[provider];
  if (!binding) throw new Error("当前 Harness 凭据桥不支持此提供商；自定义端点需先接入对应运行配置");
  const profile: { apiKeyEnv: string; baseURL?: string; api?: string } = { apiKeyEnv: binding.variable };
  if (custom) {
    const baseURL = read("custom", "baseUrl");
    const api = read("custom", "apiStyle");
    let parsed: URL;
    try { parsed = new URL(baseURL ?? ""); } catch { throw new Error("自定义 API 地址无效"); }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error("自定义 API 地址必须是不含凭据、查询参数和片段的 HTTP(S) 地址");
    if (api !== "openai-completions" && api !== "openai-responses") throw new Error("当前自定义运行端支持 openai-completions 或 openai-responses");
    profile.baseURL = parsed.href.replace(/\/$/, "");
    profile.api = api;
  }
  const key = read(binding.storeId, "apiKey") || (custom ? "xiling-local" : undefined);
  if (!key?.trim()) throw new Error("所选模型未配置 API Key，请在模型设置中保存密钥");
  // Environment is a replacement, not a merge: no other provider/data-account secrets.
  const env: Record<string, string | undefined> = {};
  const allowed = new Set(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "PATHEXT", "COMSPEC"]);
  for (const [name, value] of Object.entries(parent)) if (allowed.has(name.toUpperCase()) && value !== undefined) env[name] = value;
  env[binding.variable] = key;
  return { env, profile, keyVariable: binding.variable, redactError: (message: string) => message.split(key).join("[REDACTED]") };
}
