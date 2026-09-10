import { useSyncExternalStore } from "react";

export type Locale = "zh-CN" | "en";
const key = "xiling.ui.locale";
const listeners = new Set<() => void>();
let locale: Locale = "zh-CN";
try { if (localStorage.getItem(key) === "en") locale = "en"; } catch { /* Private browsing */ }
const syncDocument = () => { if (typeof document !== "undefined") document.documentElement.lang = locale; };
syncDocument();
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== key) return;
  locale = event.newValue === "en" ? "en" : "zh-CN";
  syncDocument(); listeners.forEach((notify) => notify());
});
export function setLocale(next: Locale) {
  locale = next;
  try { localStorage.setItem(key, next); } catch { /* Session preference still works */ }
  syncDocument(); listeners.forEach((notify) => notify());
}
const english: Record<string, string> = {
  "新对话": "New conversation", "运行图": "Agent flow", "发送": "Send", "仅文字输入": "Text only", "预览": "Preview", "溯源": "Provenance", "审阅": "Review", "尚无真实科研产物": "No research artifacts yet", "全屏查看产物": "Expand artifacts", "关闭产物面板": "Close artifacts", "正在恢复科研工作区…": "Restoring workspace…", "按需加载当前视图…": "Loading view…",
  "首页": "Home", "对话": "Chat", "需要关注": "Attention", "科研画布": "Research canvas", "项目": "Projects", "文献工作台": "Literature", "设置": "Settings",
  "当前项目": "Current project", "切换项目": "Switch project", "打开视图": "Open view", "开放问答": "Explore", "科研项目": "Research projects", "新建或管理项目": "Manage projects", "新建对话": "New chat", "对话历史": "Recent chats", "正在恢复…": "Restoring…", "这个项目还没有对话": "No conversations yet", "搜索与跳转": "Search & navigate", "返回上一视图": "Go back", "工作区": "Workspace", "新建研究对话": "New research chat", "删除对话": "Delete conversation", "取消": "Cancel", "删除": "Delete",
  "常规": "General", "主题": "Appearance", "智能体": "Agents", "子智能体": "Subagents", "技能": "Skills", "连接": "Connections", "模型 API 连接": "Model connections", "文献服务": "Literature services", "科研数据账户": "Research data accounts", "汐灵设置": "Xi Ling settings", "界面主题": "Theme", "灵境": "Lingjing", "破晓": "Dawn", "语言": "Language", "界面语言": "Interface language", "进入工作区": "Enter workspace", "汐灵": "Xi Ling", "保存": "Save", "清除": "Clear", "测试连接": "Test connection", "刷新目录": "Refresh catalog", "关联能力": "Capabilities", "允许能力": "Allowed capabilities", "已安装": "installed",
};
export function translate(text: string, language: Locale): string {
  return language === "en" ? english[text] ?? text : text;
}
export function useLocale() {
  const language = useSyncExternalStore((notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; }, () => locale);
  return { locale: language, setLocale, t: (text: string) => translate(text, language) };
}
