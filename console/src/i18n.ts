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
  "nav.playground": ["调试台", "Playground"],
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
  "login.locked": ["登录失败次数过多，请 {s}后再试", "Too many failed sign-ins; try again in {s}"],
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
  "ov.tokens": ["Token 数", "Tokens"],
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
  "ch.rekeyNotice": [
    "Base URL 改到了另一个地址（协议/域名/端口不同）。出于安全考虑，已保存的 {n} 个 key 不会发往新地址：请在下方重新输入新地址使用的 key，保存后将替换全部旧 key。",
    "The base URL moves to another origin (scheme, host or port). For safety the {n} saved key(s) are never sent to a new origin: enter the key(s) for the new address below; saving replaces all old keys.",
  ],
  "ch.rekeyLabel": ["新地址的 key（必填）", "Keys for the new address (required)"],
  "ch.rekeyRequired": [
    "更换到新地址时必须重新输入至少一个 key",
    "Enter at least one key: a new origin needs its key(s) again",
  ],
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
  "l.tokens": ["Token 数", "Tokens"],
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
  "s.limits": ["请求上限", "Request limits"],
  "s.maxOutputTokens": ["最大输出 token（全局）", "Max output tokens (global)"],
  "s.maxOutputTokensHint": [
    "适用于未在元数据中声明 maxOutputTokens 的模型；超过即 400 拒绝，不截断。留空 = 默认 65536。",
    "For models whose metadata has no maxOutputTokens; a larger max_tokens is rejected with 400, never clamped. Empty = default 65536.",
  ],
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
  // added 2026-11-05 (real-usage UI test fixes)
  view: ["查看", "View"],
  listSep: ["、", ", "],
  head: ["当前", "HEAD"],
  fixFields: ["保存失败：请修正标红的字段", "Not saved: fix the highlighted fields"],
  unsavedConfirm: ["有未保存的修改，确定关闭？", "Discard unsaved changes?"],
  noChanges: ["没有修改", "No changes"],
  dismiss: ["关闭提示", "Dismiss"],
  "dur.s": ["{n} 秒", "{n}s"],
  "dur.m": ["{n} 分钟", "{n} min"],
  "dur.ms": ["{m} 分 {s} 秒", "{m} min {s}s"],
  "who.key": ["密钥", "key"],
  more: ["展开", "More"],
  less: ["收起", "Less"],
  other: ["其他", "Other"],
  noKey: ["（无密钥）", "(no key)"],
  noneParen: ["（无）", "(none)"],
  "breaker.closed": ["正常（闭合）", "closed"],
  "breaker.open": ["熔断中（断开）", "open"],
  "breaker.half_open": ["试探中（半开）", "half-open"],
  "ch.testNever": ["点“测试连通性”测量", "Click Test connection to measure"],
  "ch.balanceFailed": ["查询失败：{e}", "Lookup failed: {e}"],
  "ch.urlInvalid": [
    "不是合法的 URL，例如 https://api.example.com/v1",
    "Not a valid URL, e.g. https://api.example.com/v1",
  ],
  "ch.urlScheme": ["只支持 http/https 地址", "Only http/https addresses"],
  "ch.urlCreds": [
    "地址里不能带用户名/密码，请把 key 填在下一步",
    "No user:password in the URL; put the key in the next step",
  ],
  "ch.urlLocal": [
    "这是本机或内网主机名，只允许公网地址（例如 https://api.example.com/v1）",
    "This is a local / intranet host name; only public addresses (e.g. https://api.example.com/v1)",
  ],
  "ch.urlPrivate": [
    "这是内网 / 本机 IP，只允许公网地址",
    "This is a private / loopback IP; only public internet addresses",
  ],
  "ch.urlHttp": ["建议使用 https，http 会明文传输 key", "Prefer https: http sends the key in clear text"],
  "ch.dupHint": ["第 {n} 个", "#{n}"],
  "ks.round_robin": ["轮询", "round robin"],
  "ks.weighted": ["按权重", "weighted"],
  "ks.fill_first": ["用满再换", "fill first"],
  "ms.fallback": ["故障转移", "fallback"],
  "ms.loadbalance": ["负载均衡", "load balance"],
  "mb.weighted": ["按权重", "weighted"],
  "mb.round_robin": ["轮询", "round robin"],
  "mb.least_inflight": ["最少并发", "least in-flight"],
  "scope.inference": ["调用模型", "inference"],
  "scope.read_only": ["只读", "read only"],
  "scope.admin": ["管理员", "admin"],
  "m.lbSet": ["负载均衡：按权重分配", "Load balanced by weight"],
  "m.lbHint": [
    "负载均衡模式：所有启用的绑定按权重分流，优先级组不起作用。",
    "Load balance: every enabled binding shares traffic by weight; priority groups are ignored.",
  ],
  "m.share": ["占比", "Share"],
  "m.sameGroup": ["与上一行同组", "same group as above"],
  "m.drag": ["拖动排序", "drag to reorder"],
  "m.up": ["上移", "up"],
  "m.down": ["下移", "down"],
  "m.keysDown": ["绑定渠道的 key 全部不可用", "every key of the bound channels is unusable"],
  "m.noBindings": [
    "还没有绑定任何渠道：启用的模型需要至少一个绑定，或先取消“启用”保存为草稿。",
    "No binding yet: an enabled model needs one, or untick Enabled to save a draft.",
  ],
  "k.rotate": ["轮换", "Rotate"],
  "k.confirmRotate": [
    "确定轮换 {name}？旧密钥立即失效，用它登录的控制台会话也会结束。",
    "Rotate {name}? The old secret stops working at once and its console sessions end.",
  ],
  "k.rotated": ["新密钥（{name}）", "New secret ({name})"],
  "l.upstream": ["上游：{m}", "upstream: {m}"],
  "l.upstreamModel": ["上游模型", "Upstream model"],
  "l.keyConsole": ["控制台调试台", "console Playground"],
  "l.keyConfig": ["配置文件密钥 {id}", "config key {id}"],
  "l.keyDeleted": ["已删除的密钥 {id}", "deleted key {id}"],
  "p.empty": [
    "选择模型，输入消息后按 Enter 发送（Shift+Enter 换行）。",
    "Pick a model, type a message and press Enter to send (Shift+Enter for a new line).",
  ],
  "p.stopped": ["已停止", "stopped"],
  "p.enterHint": ["Enter 发送 · Shift+Enter 换行", "Enter to send · Shift+Enter for a new line"],
  "u.fromAfterTo": ["开始日期不能晚于结束日期", "The start date must not be after the end date"],
  "u.badTz": [
    "“{tz}” 不是有效的时区，例如 Asia/Shanghai 或 UTC",
    '"{tz}" is not a valid time zone, e.g. Asia/Shanghai or UTC',
  ],
  "u.badDate": ["请填写完整的日期", "Enter complete dates"],
  "v.detail": ["详情", "Detail"],
  "v.wholeItem": ["（整项）", "(whole item)"],
  "v.field.name": ["名称", "name"],
  // version summaries (the server writes English; parsed back into these)
  "vs.create": ["创建{type}“{name}”", 'Create {type} "{name}"'],
  "vs.update": ["修改{type}“{name}”（{fields}）", 'Update {type} "{name}" ({fields})'],
  "vs.delete": ["删除{type}“{name}”", 'Delete {type} "{name}"'],
  "vs.addKeys": ["向渠道“{name}”添加 {n} 个 key", 'Add {n} key(s) to channel "{name}"'],
  "vs.keyOp": ["{op} {hint}（渠道“{name}”）", '{op} {hint} on channel "{name}"'],
  "vs.bindings": ["设置模型“{name}”的 {n} 个绑定", 'Set {n} binding(s) of model "{name}"'],
  "vs.settings": ["修改设置（{fields}）", "Update settings ({fields})"],
  "vs.rollback": ["回滚到配置版本 #{v}", "Roll back to config version #{v}"],
  "vs.import": [
    "从配置文件导入 {n} 个渠道及路由设置",
    "Imported {n} channel(s) and routing settings from the config file",
  ],
  "vs.noFields": ["无字段", "no fields"],
  "vs.op.update_key": ["修改 key", "Update key"],
  "vs.op.enable_key": ["启用 key", "Enable key"],
  "vs.op.disable_key": ["停用 key", "Disable key"],
  "vs.op.delete_key": ["删除 key", "Delete key"],
  "rt.channel": ["渠道", "channel"],
  "rt.model": ["模型", "model"],
  "rt.channel_key": ["渠道 key", "channel key"],
  "rt.api_key": ["密钥", "key"],
  "rt.console_session": ["控制台会话", "console session"],
  "rt.runtime_config": ["运行配置", "runtime config"],
  "rt.settings": ["设置", "settings"],
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

type Pair = readonly [string, string];

/** Audit actions (server codes) → labels. Unknown actions show their code. */
const ACTIONS: Record<string, Pair> = {
  create: ["创建", "create"],
  update: ["修改", "update"],
  delete: ["删除", "delete"],
  import: ["导入配置", "import"],
  rollback: ["回滚", "rollback"],
  add_keys: ["添加 key", "add keys"],
  update_key: ["修改 key", "update key"],
  enable_key: ["启用 key", "enable key"],
  disable_key: ["停用 key", "disable key"],
  delete_key: ["删除 key", "delete key"],
  set_bindings: ["设置绑定", "set bindings"],
  key_create: ["创建密钥", "key create"],
  key_update: ["修改密钥", "key update"],
  key_rotate: ["轮换密钥", "key rotate"],
  key_revoke: ["吊销密钥", "key revoke"],
  key_delete: ["删除密钥", "key delete"],
  key_reset_usage: ["用量清零", "key usage reset"],
  key_auto_disabled: ["上游 key 自动停用", "upstream key auto-disabled"],
  key_auto_enabled: ["上游 key 自动恢复", "upstream key auto-enabled"],
  console_login: ["控制台登录", "console sign-in"],
  console_login_failed: ["控制台登录失败", "console sign-in failed"],
  console_logout: ["控制台退出", "console sign-out"],
  console_session_revoked: ["吊销控制台会话", "console session revoked"],
  channel_test: ["测试渠道", "channel test"],
  channel_fetch_models: ["拉取模型列表", "fetch models"],
};

/** Field / column names in summaries, diffs and audit details → labels. */
const FIELDS: Record<string, Pair> = {
  name: ["名称", "name"],
  displayName: ["显示名", "display name"],
  display_name: ["显示名", "display name"],
  description: ["描述", "description"],
  enabled: ["启用", "enabled"],
  metadata: ["元数据", "metadata"],
  strategy: ["路由策略", "strategy"],
  balance: ["组内均衡", "balance mode"],
  bindings: ["绑定", "bindings"],
  baseURL: ["Base URL", "base URL"],
  base_url: ["Base URL", "base URL"],
  priority: ["优先级", "priority"],
  models: ["模型", "models"],
  keyStrategy: ["多 key 策略", "key strategy"],
  keyCooldownSeconds: ["429 冷却秒数", "429 cooldown"],
  preset: ["预设", "preset"],
  settings: ["设置", "settings"],
  aliases: ["别名", "aliases"],
  plugins: ["插件", "plugins"],
  limits: ["请求上限", "limits"],
  modelSource: ["模型来源", "model source"],
  models_explicit: ["显式模型", "explicit models"],
  compatibility: ["兼容设置", "compatibility"],
  weight: ["权重", "weight"],
  status: ["状态", "status"],
  hint: ["key", "key"],
  kind: ["类型", "kind"],
  upstreamModel: ["上游模型", "upstream model"],
  upstream_model: ["上游模型", "upstream model"],
  channel: ["渠道", "channel"],
  channels: ["渠道", "channels"],
  keys: ["上游 key", "upstream keys"],
  apiKeys: ["上游 key", "upstream keys"],
  allowedModels: ["可用模型", "allowed models"],
  quotaTokens: ["token 额度", "token quota"],
  rpm: ["RPM", "RPM"],
  tpm: ["TPM", "TPM"],
  expiresAt: ["过期时间", "expires"],
  scopes: ["权限", "scopes"],
  url_policy: ["地址策略", "URL policy"],
  last_error: ["最近错误", "last error"],
  params: ["参数覆盖", "parameter overrides"],
  contextWindow: ["上下文窗口", "context window"],
  maxOutputTokens: ["最大输出 token", "max output tokens"],
  inputModalities: ["输入类型", "input types"],
  structuredOutput: ["结构化输出", "structured output"],
  tools: ["工具调用", "tools"],
  parallelTools: ["并行工具调用", "parallel tools"],
  reasoning: ["推理", "reasoning"],
  webSearch: ["联网搜索", "web search"],
  systemMessage: ["系统消息", "system message"],
  developerRole: ["developer 角色", "developer role"],
  changed: ["修改的字段", "changed"],
  fields: ["字段", "fields"],
  ip: ["IP", "IP"],
  error: ["错误", "error"],
  httpStatus: ["HTTP 状态", "HTTP status"],
  to: ["目标版本", "to version"],
  from: ["原版本", "from version"],
  ok: ["成功", "ok"],
  latencyMs: ["延迟（ms）", "latency (ms)"],
  usedTokensBefore: ["清零前已用", "used before reset"],
  sessionsEnded: ["结束的会话数", "sessions ended"],
  channelId: ["渠道", "channel"],
  count: ["数量", "count"],
};

/** Stable Admin API error codes → messages. {detail} = the server's own text. */
const ERRORS: Record<string, Pair> = {
  invalid_credentials: ["密钥无效", "Invalid key"],
  session_expired: ["会话已过期，请重新登录", "Session expired; sign in again"],
  login_locked: ["失败次数过多，请 {wait}后再试", "Too many failures; try again in {wait}"],
  auth_locked: ["失败次数过多，请 {wait}后再试", "Too many failures; try again in {wait}"],
  insufficient_scope: ["权限不足：这个操作需要管理员权限", "Not allowed: this needs the admin scope"],
  csrf_token_invalid: ["安全校验失败，请刷新页面后重试", "Security check failed; reload the page and retry"],
  csrf_rejected: ["跨站请求被拒绝", "Cross-site request rejected"],
  revision_mismatch: ["已被修改，请刷新", "Changed by someone else; please refresh"],
  precondition_required: ["缺少版本信息，请刷新后重试", "Missing revision; refresh and retry"],
  invalid_if_match: ["版本信息无效，请刷新后重试", "Invalid revision; refresh and retry"],
  name_taken: ["名称“{name}”已被占用", 'The name "{name}" is already taken'],
  channel_in_use: [
    "该渠道仍被模型 {models} 绑定，请先移除这些绑定",
    "The channel is still bound by model(s) {models}; remove those bindings first",
  ],
  unsafe_base_url: ["Base URL 不被允许：{detail}", "Base URL not allowed: {detail}"],
  api_keys_required_on_base_url_change: [
    "更换到新地址时必须重新输入至少一个 key",
    "Enter at least one key: a new origin needs its key(s) again",
  ],
  config_invalid: ["配置校验未通过，修改未生效：{detail}", "The change was not applied: {detail}"],
  config_read_only: [
    "当前为文件配置模式（只读），不能在控制台修改",
    "File config mode (read-only): the console cannot change it",
  ],
  not_found: ["未找到（可能已被删除），请刷新", "Not found (maybe deleted); please refresh"],
  key_not_found: ["密钥不存在（可能已被删除），请刷新", "Key not found (maybe deleted); please refresh"],
  invalid_json: ["请求格式错误", "Malformed request"],
  unsupported_media_type: ["请求格式错误", "Malformed request"],
  internal_error: ["服务器内部错误，修改未生效", "Internal error; the change was not applied"],
  rate_limited: ["请求过于频繁，请稍后再试", "Too many requests; try again later"],
  upstream_unreachable: ["无法连接上游：{detail}", "Upstream unreachable: {detail}"],
  upstream_error: ["上游返回错误：{detail}", "Upstream error: {detail}"],
  upstream_invalid_response: ["上游响应无法解析：{detail}", "Upstream response not understood: {detail}"],
  model_no_bindings: [
    "启用的模型至少需要绑定一个渠道（或先保存为停用）",
    "An enabled model needs at least one binding (or save it disabled)",
  ],
  invalid_model_name: ["模型名不合法：{detail}", "Invalid model name: {detail}"],
  model_not_found: ["模型不存在或未发布", "Model not found or not published"],
  model_unavailable: ["模型暂时没有可用的渠道", "The model has no available channel right now"],
  model_not_allowed: ["这个密钥不能调用该模型", "This key may not call that model"],
  max_tokens_exceeded: ["max_tokens 超过了模型的最大输出：{detail}", "max_tokens is over the model's limit: {detail}"],
  conflicting_max_tokens: ["max_tokens 与 max_completion_tokens 不一致", "max_tokens and max_completion_tokens differ"],
  insufficient_quota: ["额度已用完", "Quota exhausted"],
  quota_exhausted: ["额度已用完", "Quota exhausted"],
  invalid_request: ["请求参数有误：{detail}", "Invalid request: {detail}"],
  invalid_parameter: ["参数有误：{detail}", "Invalid parameter: {detail}"],
  missing_parameter: ["缺少参数：{detail}", "Missing parameter: {detail}"],
  invalid_group_by: ["分组方式无效", "Invalid group-by"],
  invalid_timezone: ["时区无效，例如 Asia/Shanghai 或 UTC", "Invalid time zone, e.g. Asia/Shanghai or UTC"],
  invalid_date: ["日期格式应为 YYYY-MM-DD", "Dates are YYYY-MM-DD"],
  date_range_inverted: ["开始日期不能晚于结束日期", "The start date must not be after the end date"],
  date_range_too_long: ["查询的日期范围太长：{detail}", "Date range too long: {detail}"],
  unhandled_exception: ["服务器内部错误", "Internal server error"],
  unknown_route: ["接口不存在", "Unknown endpoint"],
};

const pickPair = (p: Pair): string => (current === "zh" ? p[0] : p[1]);

export function actionLabel(action: string): string {
  const p = ACTIONS[action];
  return p ? pickPair(p) : action;
}

export function fieldLabel(field: string): string {
  const p = FIELDS[field];
  return p ? pickPair(p) : field;
}

/** "900" → "15 分钟" / "15 min"; "75" → "1 分 15 秒". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t("dur.s", { n: s });
  if (s % 60 === 0) return t("dur.m", { n: s / 60 });
  return t("dur.ms", { m: Math.floor(s / 60), s: s % 60 });
}

/** Known English server phrases → Chinese (field errors, generic invalid_request texts). English mode: unchanged. */
const PHRASES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^use letters, digits and (.+?) \(no spaces\)$/, (m) => `只能使用字母、数字和 ${m[1]}（不能有空格）`],
  [/^from must not be after to$/, () => "开始日期不能晚于结束日期"],
  [
    /^Model names use letters, digits and (.+?) only/,
    (m) => `模型名只能使用字母、数字和 ${m[1]}（不能有空格或其他字符）`,
  ],
  [/^The model name is empty\.$/, () => "模型名不能为空"],
  [
    /^The model name is (\d+) characters long; model names are at most (\d+)/,
    (m) => `模型名有 ${m[1]} 个字符，最多 ${m[2]} 个`,
  ],
  [/^at least one binding is required$/, () => "至少需要一个绑定"],
  [/^An enabled model needs at least one binding/, () => "启用的模型至少需要一个绑定（或保存为停用）"],
  [/^tz must be an IANA time zone/, () => "时区无效，例如 Asia/Shanghai 或 UTC"],
  [/^(from|to) must be a date/, () => "日期格式应为 YYYY-MM-DD"],
  [/^at most (\d+) days per query$/, (m) => `一次最多查询 ${m[1]} 天`],
  [
    /points to an? (.+?); only public internet addresses are allowed$/,
    (m) => `指向非公网地址（${m[1]}），只允许公网地址`,
  ],
  [/^baseURL host "(.+)" is a local name/, (m) => `主机“${m[1]}”是本机/内网名称，只允许公网地址`],
  [/^baseURL host "(.+)" is not a fully qualified public host name$/, (m) => `主机“${m[1]}”不是完整的公网域名`],
  [
    /^host "(.+)" resolves to (\S+), an? (.+?); only public/,
    (m) => `主机“${m[1]}”解析到 ${m[2]}（${m[3]}），只允许公网地址`,
  ],
  [/^cannot resolve host "(.+?)"/, (m) => `无法解析主机“${m[1]}”`],
  [/^host "(.+)" did not resolve to any address$/, (m) => `主机“${m[1]}”没有解析到任何地址`],
  [/^baseURL is not a valid URL$/, () => "Base URL 不是合法的 URL"],
  [/^baseURL must use http or https$/, () => "Base URL 只支持 http/https"],
  [/^baseURL must not contain credentials/, () => "Base URL 里不能带用户名/密码，请把 key 作为渠道 key 添加"],
  [
    /^baseURL must not carry a credential in its query/,
    () => "Base URL 的查询参数里不能带凭据，请把 key 作为渠道 key 添加",
  ],
  [/^baseURL must be a literal URL/, () => "Base URL 必须是字面地址（环境变量引用只能写在配置文件里）"],
  [/^Too small: expected (?:number|int) to be >=?\s*(\S+)$/, (m) => `不能小于 ${m[1]}`],
  [/^Too big: expected (?:number|int) to be <=?\s*(\S+)$/, (m) => `不能大于 ${m[1]}`],
  [/^Too small: expected string to have >=?\s*(\d+) characters?$/, (m) => `至少 ${m[1]} 个字符`],
  [/^Too big: expected string to have <=?\s*(\d+) characters?$/, (m) => `最多 ${m[1]} 个字符`],
  [/^Too small: expected array to have >=?\s*(\d+) items?$/, (m) => `至少需要 ${m[1]} 项`],
  [/^Invalid input: expected (\w+), received (\w+)$/, (m) => `类型错误：应为 ${m[1]}，实际是 ${m[2]}`],
  [/^Required$|^Invalid input: expected \w+, received undefined$/, () => "必填"],
];

export function localizeServerText(msg: string): string {
  if (current !== "zh") return msg;
  for (const [re, fn] of PHRASES) {
    const m = msg.match(re);
    if (m) return fn(m);
  }
  return msg;
}

/**
 * The message to show for an Admin API error: by its stable `code` when the
 * console knows it (zh / en), else the server's own message.
 */
export function errorMessage(code: string, serverMessage: string, extra: { retryAfter?: number } = {}): string {
  const p = ERRORS[code];
  const local = localizeServerText(serverMessage);
  if (!p) return local;
  // A generic code whose text the console knows: the translated text alone reads better than "参数有误：…".
  if ((code === "invalid_request" || code === "invalid_model_name") && local !== serverMessage) return local;
  const name = serverMessage.match(/"([^"]+)"/)?.[1] ?? "";
  const models = (serverMessage.match(/model\(s\) (.+?);/)?.[1] ?? "").replace(/"/g, "");
  return pickPair(p)
    .split("{wait}")
    .join(fmtDuration(extra.retryAfter ?? Number(serverMessage.match(/(\d+)s\b/)?.[1] ?? 60)))
    .split("{name}")
    .join(name)
    .split("{models}")
    .join(
      models
        ? current === "zh"
          ? models
              .split(", ")
              .map((x) => `“${x}”`)
              .join("、")
          : models
        : "",
    )
    .split("{detail}")
    .join(local.replace(/^The change was not applied: /, ""));
}

/** For tests: the extra label tables. */
export const LABEL_TABLES: Readonly<Record<string, Readonly<Record<string, Pair>>>> = { ACTIONS, FIELDS, ERRORS };

/** For tests: the dictionary's keys and both languages. */
export const DICTIONARY: Readonly<Record<string, readonly [string, string]>> = D;
