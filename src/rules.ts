import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { RE2JS } from "re2js";
import { trimSpace } from "./textprep";

export interface Cond { field: string; op: string; value?: string }
export interface TimeWindow { from: string; to: string; days?: string[]; zone?: string }
export interface Rule {
  use: string; intent?: string; more?: string[]; useEffort?: string;
  tokens?: number; images?: boolean; effort?: string; agents?: string[];
  compact?: boolean; time?: TimeWindow; folders?: string[]; exceptFolders?: string[];
  where?: Cond[]; pause?: boolean; [key: string]: unknown;
}
export interface RuleRequest {
  agent?: string; folder?: string; time?: string; tokens?: number; images?: boolean;
  effort?: string; thinking?: boolean; off?: boolean; compact?: boolean; subagent?: boolean;
  message?: string; system?: string[]; last?: string[]; intent?: string;
}
export interface Group {
  id: string; name?: string; members: string[]; classifier?: string; intentSure?: number | null;
  affinity?: string; routing?: string;
  rules: Rule[]; [key: string]: unknown;
}
export interface UnknownCond { rule: number; condition: string }
export const efforts = ["low", "medium", "high", "xhigh", "max"];
const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Go's EqualFold follows single-rune Unicode folding, without expanding ß to SS.
const fold = (s: string) => Array.from(s).map(c => {
  const upper = c.toUpperCase();
  return Array.from(upper).length === 1 ? upper.toLowerCase() : c;
}).join("");
export const equalFold = (a: string, b: string) => fold(a) === fold(b);
export function folderKey(value: string): string {
  let p = trimSpace(value).replaceAll("\\", "/");
  if (p === "~" || p.startsWith("~/")) p = homedir().replaceAll("\\", "/") + p.slice(1);
  let foldCase = process.platform === "darwin" || process.platform === "win32";
  p = p.replace(/^\/\/wsl(?:\$|\.localhost)\/[^/]+(?:\/|$)/i, "/");
  if (/^[A-Za-z]:(?:\/|$)/.test(p)) p = "/mnt/" + p[0].toLowerCase() + p.slice(2);
  const mount = /^\/mnt\/([A-Za-z])(?:\/|$)/.exec(p);
  if (mount) { p = "/mnt/" + mount[1].toLowerCase() + p.slice(6); foldCase = true; }
  if (!p.startsWith("/")) return "";
  p = posix.normalize(p).replace(/\/$/, "") || "/";
  return foldCase ? p.toLowerCase() : p;
}
export function FolderUnder(folder: string, root: string): boolean {
  const f = folderKey(folder), r = folderKey(root);
  return !!f && !!r && (f === r || r === "/" || f.startsWith(r + "/"));
}
export function clockMinutes(s: string): number | null {
  let v = Array.from(trimSpace(s)).map(c => {
    if (c >= "０" && c <= "９") return String.fromCharCode(c.charCodeAt(0) - "０".charCodeAt(0) + 48);
    if (":：.．hH時时点點".includes(c)) return ":";
    return c === "分" ? "" : c;
  }).join("");
  const at = v.indexOf(":");
  let h = at >= 0 ? v.slice(0, at) : v;
  let m = at >= 0 ? v.slice(at + 1) : "";
  if (at < 0 && v.length >= 3) { h = v.slice(0, -2); m = v.slice(-2); }
  m = trimSpace(m);
  if ((at >= 0 && m === "") || (at < 0 && v.length <= 2)) m = "00";
  if (!/^[0-9]{1,2}$/.test(h) || !/^[0-9]{2}$/.test(m) || +h > 23 || +m > 59) return null;
  return +h * 60 + +m;
}
export function timeHolds(w: TimeWindow, at: string): boolean {
  const from = clockMinutes(w.from), to = clockMinutes(w.to), date = new Date(at);
  if (from === null || to === null || !Number.isFinite(date.getTime())) return false;
  let day: number, minutes: number;
  try {
    const fields = new Intl.DateTimeFormat("en-US", { timeZone: w.zone || undefined, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const get = (t: string) => fields.find(f => f.type === t)!.value;
    day = weekdays.indexOf(get("weekday").toLowerCase());
    minutes = +get("hour") * 60 + +get("minute");
  } catch { return false; }
  if (from < to && (minutes < from || minutes >= to)) return false;
  if (from > to) {
    if (minutes >= to && minutes < from) return false;
    if (minutes < to) day = (day + 6) % 7;
  }
  return !w.days?.length || w.days.includes(weekdays[day]);
}
const patterns = new Map<string, RE2JS>();
function textHolds(c: Cond, texts: string[]): boolean {
  const value = (c.value ?? "").toLowerCase();
  let re: RE2JS | undefined;
  if (c.op === "matches") {
    try {
      re = patterns.get(c.value ?? "");
      if (!re) { re = RE2JS.compile("(?i)" + (c.value ?? "")); patterns.set(c.value ?? "", re); }
    } catch { return false; }
  }
  for (const text of texts) {
    if ((c.op === "contains" || c.op === "excludes") && text.toLowerCase().includes(value)) return c.op === "contains";
    if (c.op === "starts" && trimSpace(text).toLowerCase().startsWith(trimSpace(value))) return true;
    if (c.op === "matches" && re!.matcher(text).find()) return true;
  }
  return c.op === "excludes";
}
export function condHolds(c: Cond, q: RuleRequest): boolean {
  switch (c.field) {
    case "tokens": {
      if (!/^[+-]?\d+$/.test(c.value ?? "")) return false;
      const n = Number(c.value), have = q.tokens ?? 0;
      return c.op === "gte" ? have >= n : c.op === "gt" ? have > n : c.op === "lt" ? have < n : c.op === "lte" ? have <= n : false;
    }
    case "effort": {
      const off = q.off || (!q.thinking && !q.effort), level = q.effort ?? "";
      const is = c.value === "off" ? off : c.value === "on" ? !off : !off && level === c.value;
      const want = efforts.indexOf(c.value ?? ""), have = efforts.indexOf(level);
      return c.op === "is" ? !!is : c.op === "not" ? !is : c.op === "gte" ? !off && want >= 0 && have >= want : c.op === "lte" ? want >= 0 && (!!off || have >= 0 && have <= want) : false;
    }
    case "agent": {
      const inside = (c.value ?? "").split(",").includes((q.agent ?? "").toLowerCase());
      return c.op === "is" ? inside : c.op === "not" ? !inside : false;
    }
    case "subagent": return c.op === "is" ? !!q.subagent : c.op === "not" ? !q.subagent : false;
    case "message": return textHolds(c, [q.message ?? ""]);
    case "system": return textHolds(c, q.system ?? []);
    case "last": return textHolds(c, q.last ?? []);
    default: return false;
  }
}
const ruleFields = new Set(["use", "more", "useEffort", "tokens", "images", "effort", "agents", "intent", "compact", "time", "folders", "exceptFolders", "where", "pause"]);
function effortKnown(q: RuleRequest, offNeeded = false): boolean {
  if (q.effort) return true;
  return q.thinking !== undefined && (!offNeeded || q.off !== undefined);
}
export function unknownConditions(r: Rule, q: RuleRequest): string[] {
  if (r.pause) return [];
  const unknown = Object.keys(r).filter(k => !ruleFields.has(k));
  if ((r.tokens ?? 0) > 0 && q.tokens === undefined) unknown.push("tokens");
  if (r.images && q.images === undefined) unknown.push("images");
  if (r.compact && q.compact === undefined) unknown.push("compact");
  if (r.time && !q.time) unknown.push("time");
  if ((r.folders?.length || r.exceptFolders?.length) && !q.folder) unknown.push("folder");
  if (r.effort && !effortKnown(q)) unknown.push("effort");
  if (r.agents?.length && q.agent === undefined) unknown.push("agent");
  for (const c of r.where ?? []) {
    const field = c.field;
    if (!(field in q) || q[field as keyof RuleRequest] === undefined || (field === "effort" && !effortKnown(q, true))) unknown.push(`where:${field}`);
  }
  return [...new Set(unknown)];
}
function hasCondition(r: Rule): boolean {
  return !!((r.tokens ?? 0) > 0 || r.images || r.effort || r.agents?.length || r.intent || r.compact || r.time || r.folders?.length || r.exceptFolders?.length || r.where?.length);
}
export function MatchesBesidesIntent(r: Rule, q: RuleRequest): boolean {
  if (r.pause || unknownConditions(r, q).length) return false;
  if ((r.tokens ?? 0) > 0 && q.tokens! < r.tokens!) return false;
  if (r.images && !q.images || r.compact && !q.compact) return false;
  if (r.time && !timeHolds(r.time, q.time!)) return false;
  if (r.folders?.length && !r.folders.some(root => FolderUnder(q.folder ?? "", root))) return false;
  if (r.exceptFolders?.some(root => FolderUnder(q.folder ?? "", root))) return false;
  if (r.effort === "on" && !q.thinking && !q.effort) return false;
  if (r.effort && r.effort !== "on" && efforts.indexOf(q.effort ?? "") < efforts.indexOf(r.effort)) return false;
  if (r.agents?.length && !r.agents.includes((q.agent ?? "").toLowerCase())) return false;
  if (r.where?.some(c => !condHolds(c, q))) return false;
  return hasCondition(r);
}
export function Matches(r: Rule, q: RuleRequest): boolean {
  return (!r.intent || equalFold(r.intent, q.intent ?? "")) && MatchesBesidesIntent(r, q);
}
export interface TraceCond {
  name: string; want: string; got: string;
  result: "pass" | "fail" | "unknown"; why: string;
}
export interface TraceRule { n: number; use: string; conds: TraceCond[]; matched: boolean; chosen: boolean }
export interface RuleWalk { index: number; walk: TraceRule[] }

const shown = (value: unknown): string => {
  if (value === undefined) return "—";
  if (typeof value === "string") return value || "（空）";
  return JSON.stringify(value);
};
function traceCond(name: string, want: unknown, got: unknown, result: TraceCond["result"], why: string): TraceCond {
  return { name, want: shown(want), got: shown(got), result, why };
}
function unknownCond(name: string, want: unknown, got: unknown): TraceCond {
  return traceCond(name, want, got, "unknown", "样本没有这个特征，按不匹配处理");
}
// Walks the same conditions Matches() reads, in the order it reads them, and
// returns the first matching rule. Replay uses this walk for its actual pick,
// so the trace is the decision, not a later reconstruction.
export function walkRules(rules: Rule[], q: RuleRequest): RuleWalk {
  const walk = rules.map((r, i): TraceRule => {
    const conds: TraceCond[] = [];
    if (r.pause) {
      conds.push(traceCond("pause", false, true, "fail", "暂停规则不参与路由"));
      return { n: i + 1, use: r.use, conds, matched: false, chosen: false };
    }
    if (r.intent) {
      const pass = equalFold(r.intent, q.intent ?? "");
      conds.push(traceCond("intent", r.intent, q.intent ?? "", pass ? "pass" : "fail", pass ? "intent 一致" : "intent 不一致"));
    }
    if ((r.tokens ?? 0) > 0) {
      if (q.tokens === undefined) conds.push(unknownCond("tokens", `>= ${r.tokens}`, "—"));
      else {
        const pass = q.tokens >= r.tokens!;
        conds.push(traceCond("tokens", `>= ${r.tokens}`, q.tokens, pass ? "pass" : "fail", pass ? "token 数达到门槛" : "token 数低于门槛"));
      }
    }
    if (r.images) {
      if (q.images === undefined) conds.push(unknownCond("images", true, "—"));
      else conds.push(traceCond("images", true, q.images, q.images ? "pass" : "fail", q.images ? "带图片" : "没有图片"));
    }
    if (r.compact) {
      if (q.compact === undefined) conds.push(unknownCond("compact", true, "—"));
      else conds.push(traceCond("compact", true, q.compact, q.compact ? "pass" : "fail", q.compact ? "已压缩" : "未压缩"));
    }
    if (r.time) {
      if (!q.time) conds.push(unknownCond("time", `${r.time.from}-${r.time.to}`, "—"));
      else {
        const pass = timeHolds(r.time, q.time);
        conds.push(traceCond("time", `${r.time.from}-${r.time.to}`, q.time, pass ? "pass" : "fail", pass ? "在时间段内" : "不在时间段内"));
      }
    }
    if (r.folders?.length) {
      if (!q.folder) conds.push(unknownCond("folders", r.folders.join(","), "—"));
      else {
        const pass = r.folders.some(root => FolderUnder(q.folder!, root));
        conds.push(traceCond("folders", r.folders.join(","), q.folder, pass ? "pass" : "fail", pass ? "folder 在列表内" : "folder 不在列表内"));
      }
    }
    if (r.exceptFolders?.length) {
      if (!q.folder) conds.push(unknownCond("exceptFolders", r.exceptFolders.join(","), "—"));
      else {
        const pass = !r.exceptFolders.some(root => FolderUnder(q.folder!, root));
        conds.push(traceCond("exceptFolders", r.exceptFolders.join(","), q.folder, pass ? "pass" : "fail", pass ? "folder 不在排除列表" : "folder 在排除列表"));
      }
    }
    if (r.effort) {
      if (!effortKnown(q)) conds.push(unknownCond("effort", r.effort, "—"));
      else {
        let pass: boolean;
        let why: string;
        if (r.effort === "on") {
          pass = !!(q.thinking || q.effort);
          why = pass ? "思考已开启" : "思考未开启";
        } else {
          const want = efforts.indexOf(r.effort), have = efforts.indexOf(q.effort ?? "");
          pass = !(have < want);
          why = pass ? "effort 达到门槛" : "effort 低于门槛";
        }
        conds.push(traceCond("effort", r.effort, q.effort ?? (q.thinking ? "thinking" : "off"), pass ? "pass" : "fail", why));
      }
    }
    if (r.agents?.length) {
      if (q.agent === undefined) conds.push(unknownCond("agents", r.agents.join(","), "—"));
      else {
        const pass = r.agents.includes(q.agent.toLowerCase());
        conds.push(traceCond("agents", r.agents.join(","), q.agent, pass ? "pass" : "fail", pass ? "agent 在列表内" : "agent 不在列表内"));
      }
    }
    for (const c of r.where ?? []) {
      const field = c.field;
      const known = field in q && q[field as keyof RuleRequest] !== undefined && !(field === "effort" && !effortKnown(q, true));
      const name = `where:${field} ${c.op}`;
      if (!known) conds.push(unknownCond(name, c.value ?? "", "—"));
      else {
        const pass = condHolds(c, q);
        conds.push(traceCond(name, c.value ?? "", shown(q[field as keyof RuleRequest]), pass ? "pass" : "fail", pass ? "条件成立" : "条件不成立"));
      }
    }
    for (const key of Object.keys(r).filter(k => !ruleFields.has(k))) {
      conds.push(unknownCond(key, "已知字段", "—"));
    }
    if (!hasCondition(r)) {
      conds.push(traceCond("条件", "至少一个非 intent 条件", "无", "fail", "没有可匹配条件"));
    }
    const matched = conds.every(c => c.result === "pass");
    return { n: i + 1, use: r.use, conds, matched, chosen: false };
  });
  const index = walk.findIndex(r => r.matched);
  if (index >= 0) walk[index].chosen = true;
  return { index, walk };
}
export function MatchRule(rules: Rule[], q: RuleRequest): number { return rules.findIndex(r => Matches(r, q)); }
export function Intents(rules: Rule[], q: RuleRequest): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (!MatchesBesidesIntent(rule, q)) continue;
    if (!rule.intent) break;
    if (!out.some(in_ => equalFold(in_, rule.intent!))) out.push(rule.intent);
  }
  return out;
}
export function unknownForRules(rules: Rule[], q: RuleRequest): UnknownCond[] {
  return rules.flatMap((r, i) => unknownConditions(r, q).map(condition => ({ rule: i + 1, condition })));
}
export interface ProviderInfo {
  id: string; decide?: string; chat?: string; responses?: string;
  anthropic?: string; gemini?: string; models?: string[];
}
export interface Config {
  groups: Group[]; providers: ProviderInfo[]; modelAPIs: Record<string, string>;
}
function magpieConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "magpie") : join(homedir(), ".config/magpie");
}
export async function readConfig(
  file = join(magpieConfigDir(), "providers.json"),
  settingsFile = join(magpieConfigDir(), "settings.json"),
): Promise<Config> {
  const config = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(config.groups)) throw new Error("providers.json groups is not an array");
  // Provider credentials are never retained or returned.
  const providers: ProviderInfo[] = Array.isArray(config.providers)
    ? config.providers.filter((p: any) => p && typeof p.id === "string").map((p: any) => ({
      id: p.id, decide: p.decide, chat: p.chat, responses: p.responses,
      anthropic: p.anthropic, gemini: p.gemini,
      models: Array.isArray(p.models) ? p.models.filter((m: unknown) => typeof m === "string") : undefined,
    }))
    : [];
  let modelAPIs: Record<string, string> = {};
  try {
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    if (settings && typeof settings.modelAPIs === "object" && !Array.isArray(settings.modelAPIs)) {
      modelAPIs = Object.fromEntries(Object.entries(settings.modelAPIs).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  return {
    groups: config.groups.filter((g: Group) => !g.hidden).map((g: Group) => ({ ...g, rules: g.rules ?? [], members: g.members ?? [] })),
    providers, modelAPIs,
  };
}
export async function readGroups(file = join(magpieConfigDir(), "providers.json")): Promise<Group[]> {
  return (await readConfig(file)).groups;
}
const jevModel = (model: string) => model.split("/").some(seg => seg.toLowerCase() === "jev" || seg.toLowerCase().startsWith("jev-"));
export function classifierSupport(
  classifier: string | undefined,
  providers?: ProviderInfo[],
  modelAPIs: Record<string, string> = {},
): { supported: boolean; reason?: string } {
  if (!classifier) return { supported: false, reason: "未设置 classifier" };
  if (classifier.startsWith("group/")) return { supported: false, reason: "阶段 A 不支持 group/<id> 分类器" };
  const at = classifier.indexOf("/");
  const providerId = at >= 0 ? classifier.slice(0, at) : "";
  const model = at >= 0 ? classifier.slice(at + 1) : classifier;
  if (providers) {
    const provider = providers.find(p => p.id === providerId) ?? providers.find(p => equalFold(p.id, providerId));
    if (!provider) return { supported: false, reason: `未找到 provider ${providerId || "(空)"}` };
    if (!provider.decide) return { supported: false, reason: `${provider.id} 没有 System One 决策接口` };
    // A decision-only provider answers every model name it lists; one that
    // also serves conversations only sends its Jev ids or a model set to
    // decide (provider/decide.go:141-184).
    const decideOnly = !provider.chat && !provider.responses && !provider.anthropic && !provider.gemini;
    if (decideOnly || jevModel(model) || modelAPIs[provider.id + "/" + model] === "decide") return { supported: true };
    return { supported: false, reason: `${provider.id}/${model} 不是 System One 决策模型` };
  }
  // Without provider metadata only Jev's path-segment naming can be checked.
  return jevModel(model) ? { supported: true } : { supported: false, reason: "阶段 A 只支持 System One Jev 分类器" };
}
