import { efforts, type Group, type Rule } from "./rules";
import { trimSpace } from "./textprep";

export interface RejectedRule { rule: number; reason: string }
export interface ApplyPlan { commands: string[]; rejected: RejectedRule[]; error?: string }

const ruleFields = new Set(["use", "more", "useEffort", "tokens", "images", "effort", "agents", "intent", "compact", "time", "folders", "exceptFolders", "where", "pause"]);

function stable(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function withoutIntentUse(rule: Rule): Record<string, unknown> {
  const { intent: _intent, use: _use, more: _more, ...rest } = rule;
  return rest;
}

function quote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'";
}

function folderWord(folder: string): string | null {
  if (typeof folder !== "string" || !folder || trimSpace(folder) !== folder || folder.includes(",")) return null;
  if (folder !== "/" && !(folder.length === 2 && folder[1] === ":") && /[\\/]$/.test(folder)) return null;
  const whole = folder === "~" || folder.startsWith("~/") || folder.startsWith("~\\") || folder.startsWith("/") ||
    folder.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(folder);
  return whole ? folder : null;
}

// renderRule turns a rule into the words ParseRule reads back. A field the
// CLI would normalize or refuse makes the rule unsafe to write back.
export function renderRule(rule: Rule, group: Group): { words?: string[]; reason?: string } {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return { reason: "规则不是对象" };
  if (rule.pause) return { reason: "不写回 pause 规则" };
  if (rule.where?.length) return { reason: "where 条件无法无损还原成 CLI 参数" };
  for (const key of Object.keys(rule)) if (!ruleFields.has(key)) return { reason: `未知字段 ${key} 无法还原成 CLI 参数` };
  const uses = [rule.use, ...(rule.more ?? [])].filter((v): v is string => typeof v === "string" && v !== "");
  if (!uses.length) return { reason: "规则没有 use" };
  if (uses.some(m => m.includes(","))) return { reason: "use 里的模型名含有逗号，CLI 会拆成多个模型" };
  for (const m of uses) if (!group.members.includes(m)) return { reason: `模型 ${m} 不在组成员里` };
  const words = ["use=" + uses.join(",")];
  if (rule.useEffort != null) {
    if (!efforts.includes(rule.useEffort)) return { reason: `use-effort=${rule.useEffort} 不是已知等级` };
    words.push("use-effort=" + rule.useEffort);
  }
  if (rule.tokens != null) {
    if (!Number.isInteger(rule.tokens) || rule.tokens < 0) return { reason: "tokens 不是非负整数" };
    if (rule.tokens > 0) words.push("tokens=" + rule.tokens);
  }
  if (rule.images) words.push("images");
  if (rule.effort != null && rule.effort !== "") {
    if (rule.effort !== trimSpace(rule.effort).toLowerCase()) return { reason: "effort 不是 CLI 会原样保存的小写值" };
    words.push("effort=" + rule.effort);
  }
  if (rule.agents?.length) {
    if (rule.agents.some(a => typeof a !== "string" || a === "" || /[,\s]/.test(a))) return { reason: "agents 含有 CLI 无法无损拆分的字符" };
    words.push("agents=" + rule.agents.join(","));
  }
  if (rule.intent != null && rule.intent !== "") {
    if (trimSpace(rule.intent) !== rule.intent || Array.from(rule.intent).length > 200 || /[\r\n\0]/.test(rule.intent)) {
      return { reason: "intent 含有 CLI 会改写的前后空白、控制字符或超过 200 字符" };
    }
    words.push("intent=" + rule.intent);
  }
  if ("compact" in rule && rule.compact !== true) return { reason: "compact 只能是无损写回的 true" };
  if (rule.compact) words.push("compact");
  if (rule.time) {
    const t = rule.time;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t.from) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t.to)) {
      return { reason: "time 的 from/to 不是规范的 HH:MM" };
    }
    if (!t.zone || t.zone !== trimSpace(t.zone)) return { reason: "time 没有时区，CLI 会自动填入本机时区，无法原样还原" };
    try { new Intl.DateTimeFormat("en-US", { timeZone: t.zone }); } catch { return { reason: `未知时区 ${t.zone}` }; }
    words.push("time=" + t.from + "-" + t.to);
    if (t.days?.length) {
      const days = t.days;
      if (days.some(d => !/^(sun|mon|tue|wed|thu|fri|sat)$/.test(d))) return { reason: "days 含有无效值" };
      if (new Set(days).size !== days.length) return { reason: "days 含有重复值，CLI 会去重" };
      words.push("days=" + days.join(","));
    }
    words.push("tz=" + t.zone);
  }
  for (const [key, flag] of [["folders", "folders"], ["exceptFolders", "except-folders"]] as const) {
    const list = rule[key] as string[] | undefined;
    if (!list?.length) continue;
    if (new Set(list).size !== list.length) return { reason: `${key} 含有重复路径，CLI 会去重` };
    const rendered = list.map(folderWord);
    if (rendered.some(f => f === null)) return { reason: `${key} 含有 CLI 会改写或拒绝的路径` };
    words.push(flag + "=" + (rendered as string[]).join(","));
  }
  return { words };
}

// planApply writes only intent and use of existing rules, plus added and
// removed rules. Everything else in the group is left alone. A baseline is
// the rules the draft was made from: if the group changed since then, the
// draft no longer describes the current rules and writing it back would
// delete rules the user never saw.
export function planApply(group: Group, draft: Group, bin: string, baseline?: Rule[]): ApplyPlan {
  const currentRules = group.rules ?? [];
  const draftRules = draft.rules ?? [];
  const rejected: RejectedRule[] = [];
  const commands: string[] = [];
  if (baseline !== undefined) {
    if (!Array.isArray(baseline)) return { commands: [], rejected: [], error: "baseline 必须是规则数组" };
    if (stable(currentRules) !== stable(baseline)) {
      return { commands: [], rejected: [], error: "路由组规则已在加载后变化，请刷新后再写回" };
    }
  }
  const currentSure = group.intentSure ?? null;
  const draftSure = draft.intentSure ?? null;
  if (currentSure !== draftSure) {
    return { commands: [], rejected: [], error: "写回只改 intent、use 和增删规则，不改 intentSure" };
  }
  // magpie drops a group's classifier when its last intent rule is removed,
  // so an add that puts an intent rule back must name the classifier the
  // group already had. The writeback never changes that classifier.
  const buildAdd = (rule: Rule, at: number): { command?: string; reason?: string } => {
    const rendered = renderRule(rule, group);
    if (rendered.reason) return { reason: rendered.reason };
    const words = [...rendered.words!];
    if (rule.intent) {
      if (!group.classifier) return { reason: "组没有 classifier，无法写回 intent 规则" };
      words.push("classifier=" + group.classifier);
    }
    return { command: [bin, "group", "rule", "add", quote(group.id), ...words.map(quote), "at=" + at].join(" ") };
  };
  if (currentRules.length === draftRules.length) {
    // Same length: touch only the rules that changed, last first so the
    // earlier places stay valid.
    for (let i = currentRules.length - 1; i >= 0; i--) {
      const a = currentRules[i], b = draftRules[i];
      if (stable(a) === stable(b)) continue;
      if (stable(withoutIntentUse(a)) !== stable(withoutIntentUse(b))) {
        rejected.push({ rule: i + 1, reason: "只能改 intent 和 use；这条规则还有其它字段变化" });
        continue;
      }
      const built = buildAdd(b, i + 1);
      if (built.reason) { rejected.push({ rule: i + 1, reason: built.reason }); continue; }
      commands.push([bin, "group", "rule", "rm", quote(group.id), String(i + 1)].join(" "));
      commands.push(built.command!);
    }
    return { commands, rejected };
  }
  // A different length: keep the common prefix and suffix, and replace the
  // middle as removals and additions.
  let prefix = 0;
  while (prefix < currentRules.length && prefix < draftRules.length && stable(currentRules[prefix]) === stable(draftRules[prefix])) prefix++;
  let suffix = 0;
  while (
    suffix < currentRules.length - prefix && suffix < draftRules.length - prefix &&
    stable(currentRules[currentRules.length - 1 - suffix]) === stable(draftRules[draftRules.length - 1 - suffix])
  ) suffix++;
  const removeCount = currentRules.length - prefix - suffix;
  const additions = draftRules.slice(prefix, draftRules.length - suffix);
  const built: string[] = [];
  for (let i = 0; i < additions.length; i++) {
    const item = buildAdd(additions[i], prefix + 1 + i);
    if (item.reason) rejected.push({ rule: prefix + i + 1, reason: item.reason });
    else built.push(item.command!);
  }
  if (rejected.length) return { commands: [], rejected, error: "草稿里有无法无损写回的规则，不生成部分替换命令" };
  for (let i = 0; i < removeCount; i++) commands.push([bin, "group", "rule", "rm", quote(group.id), String(prefix + 1)].join(" "));
  commands.push(...built);
  return { commands, rejected };
}
