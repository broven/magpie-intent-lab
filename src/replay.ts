import { intentOf, jevSure, noIntent, type Before, type JevClient, type Verdict } from "./jev";
import { Intents, unknownForRules, walkRules, type Group, type Rule, type RuleRequest, type TraceRule } from "./rules";
import { sessionId, type Sample } from "./history";

export interface TraceStripped {
  originalChars: number; reminders: number; beforeRequestChars: number; wholeInjection: boolean;
}
export interface TraceCut {
  head: number; tail: number; marker: string;
  beforeChars: number; afterChars: number; truncated: boolean; message: string;
}
export interface TracePrev {
  user: string; reply: string; intent: string; carried: boolean; candidates: string[];
}
export interface TraceJevRequest {
  model: string; candidates: string[]; body: unknown;
  state: Record<string, string>; levels: boolean;
}
export interface TraceJevAnswer {
  model: string; choice: string; confidence: number;
  probabilities: Record<string, number>; sure: number; topic: boolean; raw: unknown;
}
export interface TraceLevelProbe { levels: boolean; work: Record<string, string> | null; cached: boolean }
export type StickyWhy = "rule" | "kept" | "initial" | "unknown";
export interface TraceSticky {
  from: string; rule: boolean; ruleUse: string; member: string; switched: boolean;
  why: StickyWhy; prefixTokens: number; prefixEstimated: boolean;
}
export interface Trace {
  stripped: TraceStripped;
  cut: TraceCut;
  prev: TracePrev;
  jevRequest: TraceJevRequest;
  jevAnswer: TraceJevAnswer | null;
  levelProbe: TraceLevelProbe | null;
  sure: number; threshold: number; passed: boolean; accepted: boolean; intent: string;
  cached: boolean;
  ruleWalk: TraceRule[];
  chosen: { n: number; use: string };
  sticky?: TraceSticky;
}
export interface SideResult {
  intent: string; said: string; sure: number; rule: number; use: string;
  member: string; switched: boolean; from: string;
  prefixTokens: number; prefixEstimated: boolean; stickyWhy: StickyWhy;
  trace: Trace;
}
export interface UnknownCond { side: "current" | "draft"; rule: number; condition: string }
export interface Row {
  id: string; agent: string; session: string; sessionId: string; folder: string; time: string;
  text: string; fullText: string;
  prev: { user: string; reply: string };
  initialMember: string; prefixTokens: number; prefixEstimated: boolean;
  current: SideResult; draft: SideResult;
  changed: boolean; unknownConds: UnknownCond[];
}
export interface StickyCounts {
  switches: number; sessions: number; prefixTokens: number;
  estimatedTokens: number; estimatedSwitches: number;
}
export interface Summary {
  current: Record<string, number>; draft: Record<string, number>;
  transitions: Record<string, Record<string, number>>; changed: number;
  sticky: { current: StickyCounts; draft: StickyCounts; diff: StickyCounts };
}
export interface RunResult { rows: Row[]; summary: Summary }

const add = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const label = (side: SideResult) => side.intent || "(none)";

// A side keeps the intent its own last turn in a session was classified as.
// Only an intent among this turn's candidates is carried, as rules.go:331-340 does.
interface Side {
  prev: Map<string, string>;
  rules: Rule[];
  intentSure?: number | null;
}

function answerOf(raw: any, levels: boolean): { model: string; confidence: number; probabilities: Record<string, number> } {
  const answers = raw?.answers ?? {};
  const a = (levels ? answers.level : answers.intent) ?? {};
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(a.probabilities ?? {})) {
    if (typeof value === "number") probabilities[key] = value;
  }
  return {
    model: typeof raw?.model === "string" ? raw.model : "",
    confidence: typeof a.confidence === "number" ? a.confidence : 0,
    probabilities,
  };
}

async function side(jev: JevClient, model: string, state: Side, sample: Sample): Promise<SideResult> {
  const session = sample.session;
  const prior = state.prev.get(session) ?? "";
  const q: RuleRequest = { ...sample.features, message: sample.fullText };
  const candidates = Intents(state.rules, q);
  const before: Before = { User: sample.prev.user || undefined, Reply: sample.prev.reply || undefined };
  if (prior && candidates.includes(prior)) before.Intent = prior;
  let verdict: Verdict = { intent: "", said: "", topic: false, sure: 0, effort: "", score: 0 };
  let raw: unknown = null, body: unknown = null, levels = false, cached = false;
  let levelProbe: TraceLevelProbe | null = null;
  if (candidates.length) {
    const asked = await jev.askJev(model, candidates, before, sample.text);
    verdict = asked.verdict;
    raw = asked.raw; body = asked.body; levels = asked.levels; cached = asked.cached;
    if (candidates.length > 1) {
      levelProbe = { levels: asked.levelProbe.levels, work: asked.levelProbe.work, cached: asked.levelProbe.cached };
    }
  }
  const threshold = state.intentSure ?? jevSure;
  const intent = intentOf(verdict, { intentSure: state.intentSure });
  q.intent = intent;
  const walk = walkRules(state.rules, q);
  const rule = walk.index;
  const chosen = rule < 0 ? { n: 0, use: "" } : { n: rule + 1, use: state.rules[rule].use };
  const passed = verdict.topic ? verdict.sure >= threshold : !!intent;
  const answer = raw ? answerOf(raw, levels) : null;
  const trace: Trace = {
    stripped: {
      originalChars: sample.prep.originalChars,
      reminders: sample.prep.reminders,
      beforeRequestChars: sample.prep.beforeRequestChars,
      wholeInjection: sample.prep.wholeInjection,
    },
    cut: { ...sample.prep.cut, message: sample.text },
    prev: {
      user: sample.prev.user, reply: sample.prev.reply,
      intent: prior, carried: !!before.Intent, candidates,
    },
    jevRequest: {
      model,
      candidates,
      body,
      state: (body && typeof body === "object" && "state" in body && body.state && typeof body.state === "object")
        ? body.state as Record<string, string>
        : { message: sample.text },
      levels,
    },
    jevAnswer: answer ? {
      model: answer.model,
      choice: verdict.said,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      sure: verdict.sure,
      topic: verdict.topic,
      raw,
    } : null,
    levelProbe,
    sure: verdict.sure,
    threshold,
    passed,
    accepted: passed && (!verdict.topic || verdict.said !== noIntent),
    intent,
    cached,
    ruleWalk: walk.walk,
    chosen,
  };
  const result: SideResult = {
    intent,
    said: verdict.said,
    sure: verdict.sure,
    rule: rule < 0 ? 0 : rule + 1,
    use: rule < 0 ? "" : state.rules[rule].use,
    member: "", switched: false, from: "",
    prefixTokens: 0, prefixEstimated: false, stickyWhy: "unknown",
    trace,
  };
  // A named level is still one of this turn's intents, as upstream carries
  // c.Intent (rules.go:331-340); "none of these" carries nothing.
  if (intent) state.prev.set(session, intent);
  else state.prev.delete(session);
  return result;
}

// session and strict keep the conversation on whoever answered it last;
// turn and off do not. The empty mode (auto) is left unknown: affine() keeps
// it only when the vendor's cache holds (affinity.go:704-723), which a
// transcript cannot tell us. Failover, rests, caps and the stick timeout are
// not simulated either.
function stickyMode(affinity: string | undefined): boolean {
  return affinity === "session" || affinity === "strict";
}

function simulateSticky(group: Group, rows: Row[], sideKey: "current" | "draft"): StickyCounts {
  const counts: StickyCounts = { switches: 0, sessions: 0, prefixTokens: 0, estimatedTokens: 0, estimatedSwitches: 0 };
  const sessions = new Map<string, Row[]>();
  for (const row of rows) {
    const list = sessions.get(row.session);
    if (list) list.push(row); else sessions.set(row.session, [row]);
  }
  for (const list of sessions.values()) {
    let previous = list[0]?.initialMember ?? "";
    let sessionSwitched = false;
    for (let i = 0; i < list.length; i++) {
      const row = list[i], side = row[sideKey];
      const ruleUse = side.rule > 0 ? side.use : "";
      const from = i === 0 ? (row.initialMember || "") : previous;
      let member = "", why: StickyWhy;
      if (ruleUse) {
        // ruleOver puts the rule's member first over whoever answered last.
        member = ruleUse;
        why = "rule";
      } else if (i === 0) {
        member = row.initialMember || "";
        why = member ? "initial" : "unknown";
      } else if (stickyMode(group.affinity) && previous) {
        member = previous;
        why = "kept";
      } else {
        member = "";
        why = "unknown";
      }
      const switched = !!from && !!member && from !== member;
      const prefixTokens = row.prefixTokens ?? 0;
      side.member = member;
      side.switched = switched;
      side.from = from;
      side.prefixTokens = prefixTokens;
      side.prefixEstimated = !!row.prefixEstimated;
      side.stickyWhy = why;
      side.trace.sticky = {
        from, rule: !!ruleUse, ruleUse, member, switched, why,
        prefixTokens, prefixEstimated: !!row.prefixEstimated,
      };
      if (switched) {
        counts.switches++;
        if (!sessionSwitched) { counts.sessions++; sessionSwitched = true; }
        counts.prefixTokens += prefixTokens;
        if (row.prefixEstimated) {
          counts.estimatedTokens += prefixTokens;
          counts.estimatedSwitches++;
        }
      }
      previous = member;
    }
  }
  return counts;
}

export async function replay(jev: JevClient, group: Group, current: Group, draft: Group, samples: Sample[], progress?: (done: number, total: number) => void): Promise<RunResult> {
  const currentState: Side = { prev: new Map(), rules: current.rules, intentSure: current.intentSure };
  const draftState: Side = { prev: new Map(), rules: draft.rules, intentSure: draft.intentSure };
  const rows: Row[] = [];
  const zeroSticky = (): StickyCounts => ({ switches: 0, sessions: 0, prefixTokens: 0, estimatedTokens: 0, estimatedSwitches: 0 });
  const summary: Summary = {
    current: {}, draft: {}, transitions: {}, changed: 0,
    sticky: { current: zeroSticky(), draft: zeroSticky(), diff: zeroSticky() },
  };
  let done = 0;
  // A session is replayed in its own order; sessions may run side by side.
  const sessions = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = sessions.get(sample.session);
    if (list) list.push(sample); else sessions.set(sample.session, [sample]);
  }
  const ordered = [...sessions.values()].map(list => list.sort((a, b) => a.time.localeCompare(b.time)));
  const limit = 4;
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, ordered.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= ordered.length) return;
      for (const sample of ordered[i]) {
        const a = await side(jev, group.classifier!, currentState, sample);
        const b = await side(jev, group.classifier!, draftState, sample);
        const q: RuleRequest = { ...sample.features, message: sample.fullText };
        const unknown: UnknownCond[] = [
          ...unknownForRules(current.rules, q).map(u => ({ side: "current" as const, ...u })),
          ...unknownForRules(draft.rules, q).map(u => ({ side: "draft" as const, ...u })),
        ];
        const row: Row = {
          id: sample.id, agent: sample.agent, session: sample.session, sessionId: sessionId(sample.session),
          folder: sample.folder, time: sample.time,
          text: sample.text, fullText: sample.fullText, prev: sample.prev,
          initialMember: sample.initialMembers?.[group.id] ?? "",
          prefixTokens: sample.prefixTokens, prefixEstimated: sample.prefixEstimated,
          current: a, draft: b,
          changed: a.intent !== b.intent || a.use !== b.use || a.rule !== b.rule,
          unknownConds: unknown,
        };
        rows.push(row);
        add(summary.current, label(a));
        add(summary.draft, label(b));
        const from = label(a);
        summary.transitions[from] ??= {};
        add(summary.transitions[from], label(b));
        if (row.changed) summary.changed++;
        done++;
        progress?.(done, samples.length);
      }
    }
  });
  await Promise.all(workers);
  rows.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  summary.sticky.current = simulateSticky(group, rows, "current");
  summary.sticky.draft = simulateSticky(group, rows, "draft");
  const diff = (a: StickyCounts, b: StickyCounts): StickyCounts => ({
    switches: b.switches - a.switches,
    sessions: b.sessions - a.sessions,
    prefixTokens: b.prefixTokens - a.prefixTokens,
    estimatedTokens: b.estimatedTokens - a.estimatedTokens,
    estimatedSwitches: b.estimatedSwitches - a.estimatedSwitches,
  });
  summary.sticky.diff = diff(summary.sticky.current, summary.sticky.draft);
  return { rows, summary };
}
