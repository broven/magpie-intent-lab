import { injected, myRequestMarker, prevCut, reminderTag, textCut } from "./textprep";
import { jevLevels, jevSure, levelSure, levelWork, noIntent } from "./jev";
import { upstream } from "./upstream";
import type { Group } from "./rules";

export interface LogicFact {
  label: string;
  value?: string;
  items?: string[];
}
export interface LogicStep {
  n: number;
  title: string;
  source: string;
  body: string;
  facts: LogicFact[];
}
export interface GroupLogic {
  upstream: string;
  group: {
    id: string; classifier: string; intentSure: number | null; threshold: number;
    intents: string[]; none: string; members: string[]; ruleCount: number;
  };
  constants: {
    injected: string[]; reminderTag: string; myRequestMarker: string;
    textCut: typeof textCut; prevCut: typeof prevCut; jevSure: number; levelSure: number;
    noIntent: string; jevLevels: string[][]; levelWork: string[];
  };
  steps: LogicStep[];
}

const uniqueIntents = (group: Group): string[] => {
  const out: string[] = [];
  for (const rule of group.rules ?? []) {
    if (!rule.intent) continue;
    if (!out.some(value => value.toLowerCase() === rule.intent!.toLowerCase())) out.push(rule.intent);
  }
  return out;
};

// Every number and list in this object comes from the ported code or the
// group being shown. The interface renders it without keeping its own copy.
export function logicFor(group: Group): GroupLogic {
  const intents = uniqueIntents(group);
  const threshold = group.intentSure ?? jevSure;
  return {
    upstream: upstream.commit,
    group: {
      id: group.id,
      classifier: group.classifier ?? "",
      intentSure: group.intentSure ?? null,
      threshold,
      intents,
      none: noIntent,
      members: group.members ?? [],
      ruleCount: group.rules?.length ?? 0,
    },
    constants: {
      injected, reminderTag, myRequestMarker, textCut, prevCut,
      jevSure, levelSure, noIntent, jevLevels, levelWork,
    },
    steps: [
      {
        n: 1,
        title: "何时判",
        source: "internal/gateway/rules.go:141-396（turnRules）",
        body: "每个 turn 开始时判一次：第一条带用户话语的新消息。同一 turn 里的后续请求沿用这次结果。",
        facts: [
          { label: "判定时机", value: "每个 turn 一次" },
          { label: "同一 turn 的后续请求", value: "沿用 turnRules 里的结果" },
        ],
      },
      {
        n: 2,
        title: "取哪段文本",
        source: "internal/gateway/prompt.go:712-786；internal/gateway/classify.go:264-290",
        body: `取最后一条 userSaid 非空的 user 消息。先去掉 system-reminder 段，只保留 ${myRequestMarker} 之后的部分；整段以注入前缀开头的文本不算用户话。`,
        facts: [
          { label: "system-reminder 标签", value: reminderTag },
          { label: "用户请求标记", value: myRequestMarker },
          { label: "截断规则", value: `前 ${textCut.head} 字 + ${JSON.stringify(textCut.marker)} + 后 ${textCut.tail} 字` },
          { label: "注入前缀表", items: injected },
        ],
      },
      {
        n: 3,
        title: "上一轮上下文",
        source: "internal/gateway/classify.go:296-335；internal/gateway/rules.go:331-340",
        body: `上一条用户话截成前 ${prevCut.userHead} + 后 ${prevCut.userTail} 字；上一条纯文本助手回复取末尾 ${prevCut.replyTail} 字，前面加 ${prevCut.replyPrefix}。只有上一轮 intent 也在本组 intents 里时，才作为 previous_message_kind 发给 Jev。`,
        facts: [
          { label: "上一轮用户", value: `前 ${prevCut.userHead} + 后 ${prevCut.userTail} 字` },
          { label: "上一轮回复", value: `末尾 ${prevCut.replyTail} 字，前缀 ${prevCut.replyPrefix}` },
          { label: "上一轮 intent", value: "只有在本组 intents 里才携带" },
        ],
      },
      {
        n: 4,
        title: "问 Jev",
        source: "internal/gateway/decide.go:120-240、342-385",
        body: `分类器是当前组的 classifier。选项是本组 intents 加 ${noIntent}。intents 多于 1 个时，先探测这些 intent 是 levels 还是 topics；noul >= ${levelSure} 判为 levels。`,
        facts: [
          { label: "分类器", value: group.classifier ?? "（未设置）" },
          { label: "选项", items: [...intents, noIntent] },
          { label: "levels 探测", value: intents.length > 1 ? "会先探测" : "只有一个 intent，不探测" },
          { label: "levels 判定阈值", value: `noul >= ${levelSure}` },
        ],
      },
      {
        n: 5,
        title: "读答案",
        source: "internal/gateway/decide.go:47-71、245-313；internal/provider/decide_wire.go:89-100",
        body: `topics：sure 由答案的 probabilities 按 Confidence 公式算出；要求 sure >= intentSure 且答案不是 ${noIntent}。levels：不受 intentSure 约束；sure < ${jevSure} 时回退到上一轮 intent。`,
        facts: [
          { label: "当前阈值 intentSure", value: String(threshold) },
          { label: "组未设置时的默认值", value: String(jevSure) },
          { label: "levels 回退阈值", value: String(jevSure) },
          { label: "sure 公式", value: "probabilities >= 2 时 max(0, (max(p) - 1/n) / (1 - 1/n))，否则用 confidence" },
          { label: "none of these", value: noIntent },
        ],
      },
      {
        n: 6,
        title: "选规则",
        source: "internal/provider/grouprule.go:573-665（Matches / Intents / MatchRule）",
        body: "从上往下第一条所有条件都满足的规则胜出，使用它的 use。非 intent 条件只有样本带对应特征时才判，否则记为 unknown 并按不匹配处理。没有命中任何规则时按组的默认路由走。",
        facts: [
          { label: "当前规则数", value: String(group.rules?.length ?? 0) },
          { label: "未命中", value: "组默认路由" },
          { label: "缺特征的条件", value: "unknown，按不匹配处理" },
        ],
      },
      {
        n: 7,
        title: "与真实路由的差异",
        source: "src/upstream.json",
        body: "输入来自 transcript，而不是请求体；移植参照的上游源码版本可能和本机 magpie 不同；非 intent 条件会出现 unknown；Jev 模型版本会变，答案里的 model 会显示出来。",
        facts: [
          { label: "移植参照上游 commit", value: upstream.commit },
          { label: "输入", value: "transcript" },
          { label: "Jev 模型版本", value: "以答案里的 model 为准" },
        ],
      },
    ],
  };
}
