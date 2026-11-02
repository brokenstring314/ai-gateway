/**
 * Dictionary i18n: every string is [中文, English]. The language defaults to
 * the browser's (zh* → Chinese, otherwise English) and the switcher's choice
 * is kept in localStorage ("aigw.lang"). No library.
 */
import { useEffect, useState } from "preact/hooks";

export type Lang = "zh" | "en";

const D = {
  // shell
  appName: ["AI 网关控制台", "AI Gateway console"],
  "nav.overview": ["概览", "Overview"],
  "nav.channels": ["渠道", "Channels"],
  "nav.models": ["模型", "Models"],
  "nav.keys": ["密钥", "Keys"],
  "nav.usage": ["用量", "Usage"],
  "nav.logs": ["日志", "Logs"],
  "nav.playground": ["Playground", "Playground"],
  "nav.settings": ["设置", "Settings"],
  "nav.versions": ["版本与审计", "Versions & audit"],
  logout: ["退出登录", "Sign out"],
  readOnly: ["只读", "read-only"],
  // login
  "login.title": ["登录控制台", "Sign in to the console"],
  "login.key": ["管理员密钥或只读密钥", "Admin or read-only key"],
  "login.submit": ["登录", "Sign in"],
  "login.hint": [
    "密钥只用于换取会话，浏览器不会保存它（会话 Cookie 为 HttpOnly）。",
    "The key is exchanged for a session and never kept in the browser (HttpOnly session cookie).",
  ],
  "login.invalid": ["密钥无效", "Invalid key"],
  "login.scope": [
    "这个密钥不能使用控制台（需要 admin 或 read_only 权限）",
    "This key cannot use the console (admin or read_only needed)",
  ],
  "login.locked": ["登录失败次数过多，请 {s} 秒后再试", "Too many failed sign-ins; try again in {s}s"],
  "session.expired": ["会话已过期，请重新登录", "Session expired; sign in again"],
  // common
  save: ["保存", "Save"],
  cancel: ["取消", "Cancel"],
  close: ["关闭", "Close"],
  delete: ["删除", "Delete"],
  edit: ["编辑", "Edit"],
  add: ["添加", "Add"],
  create: ["创建", "Create"],
  refresh: ["刷新", "Refresh"],
  loading: ["加载中…", "Loading…"],
  none: ["无", "none"],
  name: ["名称", "Name"],
  status: ["状态", "Status"],
  enabled: ["启用", "Enabled"],
  disabled: ["已停用", "Disabled"],
  actions: ["操作", "Actions"],
  confirmDelete: ["确定删除 {name}？", "Delete {name}?"],
  savedVersion: ["已生效 · 版本 #{v}", "Live · version #{v}"],
  saved: ["已保存", "Saved"],
  conflict: ["已被修改，请刷新", "Changed by someone else; please refresh"],
  error: ["出错了", "Error"],
  noData: ["暂无数据", "No data yet"],
  unlimited: ["不限", "unlimited"],
  yes: ["是", "yes"],
  no: ["否", "no"],
  back: ["上一步", "Back"],
  next: ["下一步", "Next"],
  copy: ["复制", "Copy"],
  copied: ["已复制", "Copied"],
  // overview
  "ov.requests": ["请求数", "Requests"],
  "ov.tokens": ["Token", "Tokens"],
  "ov.errors": ["错误", "Errors"],
  "ov.errorRate": ["错误率", "Error rate"],
  "ov.trend": ["近 {n} 天趋势", "Last {n} days"],
  "ov.health": ["渠道健康", "Channel health"],
  "ov.breaker": ["熔断器", "Circuit breaker"],
  "ov.keys": ["上游 key", "Upstream keys"],
  "ov.version": ["版本", "Version"],
  "ov.upstream": ["上游可用", "Upstream available"],
  // channels
  "ch.add": ["添加渠道", "Add channel"],
  "ch.preset": ["预设", "Preset"],
  "ch.baseURL": ["Base URL", "Base URL"],
  "ch.baseURLHint": ["留空使用预设默认地址；只允许公网地址", "Empty = the preset's default; public internet only"],
  "ch.keys": ["上游 key", "Upstream keys"],
  "ch.keysHint": [
    "每行一个 key；保存后加密存储，只显示末尾几位",
    "One key per line; stored encrypted, only a hint is shown",
  ],
  "ch.keyStrategy": ["多 key 策略", "Key strategy"],
  "ch.cooldown": ["429 冷却秒数", "429 cooldown (s)"],
  "ch.priority": ["排序优先级", "Priority"],
  "ch.models": ["模型", "Models"],
  "ch.test": ["测试连通性", "Test connection"],
  "ch.fetchModels": ["拉取模型列表", "Fetch models"],
  "ch.publish": ["发布所选模型", "Publish selected models"],
  "ch.latency": ["延迟", "Latency"],
  "ch.balance": ["余额", "Balance"],
  "ch.balanceHint": ["上游账户余额，仅供参考，便于及时充值", "Upstream account balance, informational only"],
  "ch.addKeys": ["添加 key", "Add keys"],
  "ch.enable": ["启用", "Enable"],
  "ch.disable": ["停用", "Disable"],
  "ch.weight": ["权重", "Weight"],
  "ch.lastError": ["最近错误", "Last error"],
  "ch.step1": ["选预设", "Preset"],
  "ch.step2": ["填 key", "Keys"],
  "ch.step3": ["测试", "Test"],
  "ch.step4": ["拉模型", "Models"],
  "ch.step5": ["勾选发布", "Publish"],
  "ch.created": ["渠道已创建", "Channel created"],
  "ch.testOk": ["连通 · {ms} ms", "OK · {ms} ms"],
  "ch.testFail": ["失败：{e}", "Failed: {e}"],
  "ch.selectAll": ["全选", "Select all"],
  "ch.publishedAs": ["对外名", "Public name"],
  "ch.derivedNote": [
    "当前模型由渠道的 models 列表派生；发布需切换为“显式模型”（设置页）。将只更新渠道的 models 列表。",
    "Models are derived from channel model lists; the selection updates this channel's list. Switch to explicit models in Settings to publish under other names.",
  ],
  "ch.keyStatus.ok": ["正常", "ok"],
  "ch.keyStatus.cooling": ["冷却中", "cooling"],
  "ch.keyStatus.disabled": ["已停用", "disabled"],
  "ch.keyStatus.invalid": ["失效（401）", "invalid (401)"],
  "ch.keyStatus.quota": ["额度用尽（402）", "out of quota (402)"],
  // models
  "m.add": ["新建模型", "New model"],
  "m.displayName": ["显示名", "Display name"],
  "m.description": ["描述", "Description"],
  "m.strategy": ["路由策略", "Strategy"],
  "m.balance": ["组内均衡", "Balance mode"],
  "m.bindings": ["绑定渠道", "Bindings"],
  "m.upstreamModel": ["上游模型", "Upstream model"],
  "m.priorityGroup": ["优先级组", "Priority group"],
  "m.dragHint": [
    "拖动排序（越靠前优先级越高），同组内按权重均衡",
    "Drag to reorder (top = highest priority); weight balances within a group",
  ],
  "m.addBinding": ["添加绑定", "Add binding"],
  "m.metadata": ["元数据", "Metadata"],
  "m.contextWindow": ["上下文窗口", "Context window"],
  "m.maxOutput": ["最大输出 token", "Max output tokens"],
  "m.inputs": ["输入类型", "Input types"],
  "m.structured": ["结构化输出", "Structured output"],
  "m.tools": ["工具调用", "Tools"],
  "m.parallelTools": ["并行工具调用", "Parallel tools"],
  "m.webSearch": ["联网搜索", "Web search"],
  "m.logprobs": ["logprobs", "logprobs"],
  "m.systemMessage": ["系统消息", "System message"],
  "m.developerRole": ["developer 角色", "Developer role"],
  "m.reasoning": ["推理", "Reasoning"],
  "m.reasoningEfforts": ["推理等级（逗号分隔）", "Reasoning efforts (comma separated)"],
  "m.available": ["可用", "available"],
  "m.unavailable": ["不可用", "unavailable"],
  "m.derived": [
    "模型由渠道派生（只读）。在设置页切换为显式模型后可编辑。",
    "Models are derived from channels (read-only). Switch to explicit models in Settings to edit.",
  ],
  "m.inherit": ["默认", "default"],
  // keys
  "k.create": ["创建密钥", "Create key"],
  "k.allowedModels": ["可用模型", "Allowed models"],
  "k.allModels": ["全部模型", "All models"],
  "k.someModels": ["仅限勾选的模型", "Only the checked models"],
  "k.noModels": ["无（不能调用任何模型）", "none (no model allowed)"],
  "k.noModelsWarn": [
    "没有勾选任何模型：这个密钥不能调用任何模型。",
    "No model checked: this key cannot call any model.",
  ],
  "k.quota": ["token 额度", "Token quota"],
  "k.rpm": ["RPM", "RPM"],
  "k.tpm": ["TPM", "TPM"],
  "k.expires": ["过期时间", "Expires"],
  "k.scopes": ["权限", "Scopes"],
  "k.used": ["已用", "Used"],
  "k.remaining": ["剩余", "Remaining"],
  "k.exhausted": ["额度已用完", "quota exhausted"],
  "k.plaintextOnce": ["请立即复制，这个密钥只显示这一次：", "Copy it now — this key is shown only once:"],
  "k.resetUsage": ["用量清零", "Reset usage"],
  "k.raiseQuota": ["调整额度", "Change quota"],
  "k.revoke": ["吊销", "Revoke"],
  "k.revoked": ["已吊销", "revoked"],
  "k.limits": ["限额", "Limits"],
  "k.confirmReset": ["确定把 {name} 的已用 token 清零？", "Reset used tokens of {name}?"],
  "k.confirmRevoke": ["确定吊销 {name}？吊销后无法恢复。", "Revoke {name}? This cannot be undone."],
  // usage
  "u.groupBy": ["分组", "Group by"],
  "u.byKey": ["按密钥", "By key"],
  "u.byModel": ["按模型", "By model"],
  "u.byChannel": ["按渠道", "By channel"],
  "u.from": ["开始", "From"],
  "u.to": ["结束", "To"],
  "u.tz": ["时区", "Time zone"],
  "u.input": ["输入", "Input"],
  "u.output": ["输出", "Output"],
  "u.cache": ["缓存命中", "Cache hit"],
  "u.reasoning": ["推理", "Reasoning"],
  "u.latency": ["平均延迟", "Avg latency"],
  "u.total": ["合计", "Total"],
  // logs
  "l.time": ["时间", "Time"],
  "l.model": ["模型", "Model"],
  "l.provider": ["渠道", "Channel"],
  "l.key": ["密钥", "Key"],
  "l.tokens": ["Token", "Tokens"],
  "l.duration": ["耗时", "Duration"],
  "l.onlyErrors": ["只看错误", "Errors only"],
  "l.prev": ["上一页", "Previous"],
  "l.next": ["下一页", "Next"],
  // playground
  "p.model": ["模型", "Model"],
  "p.system": ["系统提示词", "System prompt"],
  "p.message": ["消息", "Message"],
  "p.send": ["发送", "Send"],
  "p.stop": ["停止", "Stop"],
  "p.stream": ["流式", "Stream"],
  "p.temperature": ["温度", "Temperature"],
  "p.maxTokens": ["最大 token", "Max tokens"],
  "p.hint": [
    "通过真实路由调用（走模型绑定、元数据校验、故障转移），用量记为 console-playground。",
    "Calls go through the real routing (bindings, metadata checks, failover); usage is recorded as console-playground.",
  ],
  "p.clear": ["清空对话", "Clear"],
  // settings
  "s.aliases": ["别名", "Aliases"],
  "s.aliasFrom": ["别名", "Alias"],
  "s.aliasTo": ["指向模型", "Model"],
  "s.plugins": ["插件（JSON）", "Plugins (JSON)"],
  "s.rateLimit": ["全局限流", "Global rate limit"],
  "s.rpm": ["每 key 每分钟请求数", "Requests per minute per key"],
  "s.tpm": ["每 key 每分钟 token", "Tokens per minute per key"],
  "s.modelSource": ["模型来源", "Model source"],
  "s.explicit": ["显式模型（可编辑）", "Explicit models (editable)"],
  "s.derivedSrc": ["由渠道 models 列表派生", "Derived from channel model lists"],
  "s.switchExplicit": ["切换为显式模型", "Switch to explicit models"],
  "s.sessions": ["控制台会话", "Console sessions"],
  "s.current": ["当前", "current"],
  "s.lastSeen": ["最近活动", "Last seen"],
  "s.expires": ["到期", "Expires"],
  "s.revokeSession": ["吊销", "Revoke"],
  "s.invalidJson": ["不是合法的 JSON", "Not valid JSON"],
  "s.language": ["语言", "Language"],
  // versions
  "v.versions": ["配置版本", "Config versions"],
  "v.version": ["版本", "Version"],
  "v.time": ["时间", "Time"],
  "v.actor": ["操作者", "Actor"],
  "v.summary": ["摘要", "Summary"],
  "v.diff": ["与当前对比", "Diff with head"],
  "v.diffPrev": ["与上一版对比", "Diff with previous"],
  "v.rollback": ["回滚到此版本", "Roll back to this version"],
  "v.confirmRollback": [
    "确定回滚到版本 #{v}？将生成一个新版本。",
    "Roll back to version #{v}? A new version is created.",
  ],
  "v.audit": ["审计日志", "Audit log"],
  "v.action": ["动作", "Action"],
  "v.resource": ["资源", "Resource"],
  "v.noDiff": ["没有差异", "No differences"],
  "v.more": ["加载更多", "Load more"],
} as const;

export type MsgKey = keyof typeof D;

function detect(): Lang {
  try {
    const saved = localStorage.getItem("aigw.lang");
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // storage unavailable
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return /^zh/i.test(nav) ? "zh" : "en";
}

let current: Lang = detect();
const listeners = new Set<(l: Lang) => void>();

export function lang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  current = l;
  try {
    localStorage.setItem("aigw.lang", l);
  } catch {
    // storage unavailable
  }
  if (typeof document !== "undefined") document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  for (const fn of listeners) fn(l);
}

export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  const pair = D[key] as readonly [string, string];
  let s = current === "zh" ? pair[0] : pair[1];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Re-render on language change. */
export function useLang(): Lang {
  const [l, set] = useState(current);
  useEffect(() => {
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return l;
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString(current === "zh" ? "zh-CN" : "en-US");
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(current === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

/** For tests: the dictionary's keys and both languages. */
export const DICTIONARY: Readonly<Record<string, readonly [string, string]>> = D;
