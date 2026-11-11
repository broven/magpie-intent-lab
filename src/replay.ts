import { intentOf, jevSure, noIntent, type Before, type JevClient, type JevMeter, type Verdict } from "./jev";
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
  stopped: boolean;
  jev: JevMeter;
  trace: Trace;
}
export interface UnknownCond { side: "current" | "draft"; rule: number; condition: string }
export interface Row {
  id: string; agent: string; session: string; sessionId: string; folder: string; time: string;
  turn: number;
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
export type SessionClass = "single" | "early" | "mid" | "miss";
export interface SessionResult {
  id: string; agent: string; folder: string; turns: number;
  first: string;
  class: SessionClass; firstHit: number | null;
  switched: boolean; from: string; to: string; prefixTokens: number;
  rows: Row[];
}
export interface TimingHistogram {
  "1": number; "2": number; "3": number; "4-5": number; "6-10": number; ">10": number;
}
export interface TimingCounts {
  k: number; stopAfterHit: boolean;
  single: number; early: number; mid: number; miss: number; multi: number;
  ratios: { early: number; mid: number; miss: number };
  histogram: TimingHistogram;
  midCost: { switches: number; prefixTokens: number; median: number; estimatedTokens: number };
}
export interface JevCounts { requests: number; hits: number }
export interface Summary {
  current: Record<string, number>; draft: Record<string, number>;
  transitions: Record<string, Record<string, number>>; changed: number;
  sticky: { current: StickyCounts; draft: StickyCounts; diff: StickyCounts };
  timing: TimingCounts;
  jev: { current: JevCounts; draft: JevCounts };
}
export interface RunResult { sessions: SessionResult[]; summary: Summary }

const add = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const label = (side: SideResult) => side.stopped ? "(未判)" : side.intent || "(none)";

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

function baseTrace(sample: Sample): Trace {
  return {
    stripped: {
      originalChars: sample.prep.originalChars,
      reminders: sample.prep.reminders,
      beforeRequestChars: sample.prep.beforeRequestChars,
      wholeInjection: sample.prep.wholeInjection,
    },
    cut: { ...sample.prep.cut, message: sample.text },
    prev: {
      user: sample.prev.user, reply: sample.prev.reply,
      intent: "", carried: false, candidates: [],
    },
    jevRequest: {
      model: "",
      candidates: [],
      body: null,
      state: { message: sample.text },
      levels: false,
    },
    jevAnswer: null,
    levelProbe: null,
    sure: 0,
    threshold: 0,
    passed: false,
    accepted: false,
    intent: "",
    cached: false,
    ruleWalk: [],
    chosen: { n: 0, use: "" },
  };
}

// With stopAfterHit, the turns after a session's first rule hit are not
// classified at all: a hit already sticks the session, and E3 only needs the
// first hit. The current side still runs every turn.
function unjudged(sample: Sample, group: Group, model: string): SideResult {
  const trace = baseTrace(sample);
  trace.jevRequest.model = model;
  trace.threshold = group.intentSure ?? jevSure;
  return {
    intent: "", said: "", sure: 0, rule: 0, use: "",
    member: "", switched: false, from: "",
    prefixTokens: 0, prefixEstimated: false, stickyWhy: "unknown",
    stopped: true, jev: { requests: 0, hits: 0 },
    trace,
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
  const meter: JevMeter = { requests: 0, hits: 0 };
  if (candidates.length) {
    const asked = await jev.askJev(model, candidates, before, sample.text, meter);
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
  const trace = baseTrace(sample);
  trace.prev = {
    user: sample.prev.user, reply: sample.prev.reply,
    intent: prior, carried: !!before.Intent, candidates,
  };
  trace.jevRequest = {
    model,
    candidates,
    body,
    state: (body && typeof body === "object" && "state" in body && body.state && typeof body.state === "object")
      ? body.state as Record<string, string>
      : { message: sample.text },
    levels,
  };
  trace.jevAnswer = answer ? {
    model: answer.model,
    choice: verdict.said,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    sure: verdict.sure,
    topic: verdict.topic,
    raw,
  } : null;
  trace.levelProbe = levelProbe;
  trace.sure = verdict.sure;
  trace.threshold = threshold;
  trace.passed = passed;
  trace.accepted = passed && (!verdict.topic || verdict.said !== noIntent);
  trace.intent = intent;
  trace.cached = cached;
  trace.ruleWalk = walk.walk;
  trace.chosen = chosen;
  const result: SideResult = {
    intent,
    said: verdict.said,
    sure: verdict.sure,
    rule: rule < 0 ? 0 : rule + 1,
    use: rule < 0 ? "" : state.rules[rule].use,
    member: "", switched: false, from: "",
    prefixTokens: 0, prefixEstimated: false, stickyWhy: "unknown",
    stopped: false, jev: meter,
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
      if (side.stopped) {
        // A stopped turn is unjudged; the rule that stopped the session keeps
        // it on the previous member, so it must not create a switch.
        member = previous;
        why = previous ? "kept" : "unknown";
      } else if (ruleUse) {
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
      const switched = !side.stopped && !!from && !!member && from !== member;
      const prefixTokens = switched ? (row.prefixTokens ?? 0) : 0;
      side.member = member;
      side.switched = switched;
      side.from = from;
      side.prefixTokens = prefixTokens;
      side.prefixEstimated = switched ? !!row.prefixEstimated : false;
      side.stickyWhy = why;
      side.trace.sticky = {
        from, rule: !!ruleUse, ruleUse, member, switched, why,
        prefixTokens, prefixEstimated: switched ? !!row.prefixEstimated : false,
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


function groupedSessions(rows: Row[], k: number): SessionResult[] {
  const bySession = new Map<string, Row[]>();
  for (const row of rows) {
    const list = bySession.get(row.session);
    if (list) list.push(row); else bySession.set(row.session, [row]);
  }
  const sessions: SessionResult[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.turn - b.turn || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
    const firstHitRow = list.find(row => !row.draft.stopped && row.draft.rule > 0);
    const firstHit = firstHitRow ? firstHitRow.turn : null;
    const cls: SessionClass = list.length === 1
      ? "single"
      : firstHit === null
        ? "miss"
        : firstHit <= k ? "early" : "mid";
    const switchedRows = list.filter(row => row.draft.switched);
    const prefixTokens = switchedRows.reduce((sum, row) => sum + (row.draft.prefixTokens ?? 0), 0);
    sessions.push({
      id: sessionId(list[0].session),
      agent: list[0].agent,
      folder: list[0].folder,
      turns: list.length,
      first: list[0].fullText || list[0].text,
      class: cls,
      firstHit,
      switched: switchedRows.length > 0,
      from: switchedRows[0]?.draft.from ?? "",
      to: switchedRows[0]?.draft.member ?? "",
      prefixTokens,
      rows: list,
    });
  }
  sessions.sort((a, b) => {
    const at = a.rows.at(-1)?.time ?? "", bt = b.rows.at(-1)?.time ?? "";
    return bt.localeCompare(at) || a.id.localeCompare(b.id);
  });
  return sessions;
}

function timingOf(sessions: SessionResult[], k: number, stopAfterHit: boolean): TimingCounts {
  const single = sessions.filter(session => session.class === "single").length;
  const early = sessions.filter(session => session.class === "early").length;
  const mid = sessions.filter(session => session.class === "mid").length;
  const miss = sessions.filter(session => session.class === "miss").length;
  const multi = early + mid + miss;
  const histogram: TimingHistogram = { "1": 0, "2": 0, "3": 0, "4-5": 0, "6-10": 0, ">10": 0 };
  for (const session of sessions) {
    if (session.class === "single" || session.firstHit === null) continue;
    const n = session.firstHit;
    if (n === 1) histogram["1"]++;
    else if (n === 2) histogram["2"]++;
    else if (n === 3) histogram["3"]++;
    else if (n <= 5) histogram["4-5"]++;
    else if (n <= 10) histogram["6-10"]++;
    else histogram[">10"]++;
  }
  const costs: number[] = [];
  let costTokens = 0, estimatedTokens = 0;
  for (const session of sessions) {
    if (session.class !== "mid") continue;
    for (const row of session.rows) {
      if (!row.draft.switched) continue;
      costs.push(row.draft.prefixTokens);
      costTokens += row.draft.prefixTokens;
      if (row.draft.prefixEstimated) estimatedTokens += row.draft.prefixTokens;
    }
  }
  costs.sort((a, b) => a - b);
  const median = costs.length
    ? Math.round(costs.length % 2 ? costs[(costs.length - 1) / 2] : (costs[costs.length / 2 - 1] + costs[costs.length / 2]) / 2)
    : 0;
  return {
    k, stopAfterHit, single, early, mid, miss, multi,
    ratios: {
      early: multi ? early / multi : 0,
      mid: multi ? mid / multi : 0,
      miss: multi ? miss / multi : 0,
    },
    histogram,
    midCost: { switches: costs.length, prefixTokens: costTokens, median, estimatedTokens },
  };
}

function sumJev(rows: Row[], sideKey: "current" | "draft"): JevCounts {
  const counts: JevCounts = { requests: 0, hits: 0 };
  for (const row of rows) {
    counts.requests += row[sideKey].jev.requests;
    counts.hits += row[sideKey].jev.hits;
  }
  return counts;
}

export async function replay(
  jev: JevClient,
  group: Group,
  current: Group,
  draft: Group,
  samples: Sample[],
  progress?: (done: number, total: number) => void,
  options: { k?: number; stopAfterHit?: boolean } = {},
): Promise<RunResult> {
  const k = options.k ?? 3;
  const stopAfterHit = !!options.stopAfterHit;
  const currentState: Side = { prev: new Map(), rules: current.rules, intentSure: current.intentSure };
  const draftState: Side = { prev: new Map(), rules: draft.rules, intentSure: draft.intentSure };
  const rows: Row[] = [];
  const zeroSticky = (): StickyCounts => ({ switches: 0, sessions: 0, prefixTokens: 0, estimatedTokens: 0, estimatedSwitches: 0 });
  const zeroCounts = (): JevCounts => ({ requests: 0, hits: 0 });
  const summary: Summary = {
    current: {}, draft: {}, transitions: {}, changed: 0,
    sticky: { current: zeroSticky(), draft: zeroSticky(), diff: zeroSticky() },
    timing: timingOf([], k, stopAfterHit),
    jev: { current: zeroCounts(), draft: zeroCounts() },
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
      let stoppedAfterHit = false;
      for (let turn = 1; turn <= ordered[i].length; turn++) {
        const sample = ordered[i][turn - 1];
        const a = await side(jev, group.classifier!, currentState, sample);
        let b: SideResult;
        if (stopAfterHit && stoppedAfterHit) {
          b = unjudged(sample, group, group.classifier!);
        } else {
          b = await side(jev, group.classifier!, draftState, sample);
          if (b.rule > 0) stoppedAfterHit = true;
        }
        const q: RuleRequest = { ...sample.features, message: sample.fullText };
        const unknown: UnknownCond[] = [
          ...unknownForRules(current.rules, q).map(u => ({ side: "current" as const, ...u })),
          ...unknownForRules(draft.rules, q).map(u => ({ side: "draft" as const, ...u })),
        ];
        const row: Row = {
          id: sample.id, agent: sample.agent, session: sample.session, sessionId: sessionId(sample.session),
          folder: sample.folder, time: sample.time,
          turn,
          text: sample.text, fullText: sample.fullText, prev: sample.prev,
          initialMember: sample.initialMembers?.[group.id] ?? "",
          prefixTokens: sample.prefixTokens, prefixEstimated: sample.prefixEstimated,
          current: a, draft: b,
          changed: !b.stopped && (a.intent !== b.intent || a.use !== b.use || a.rule !== b.rule),
          unknownConds: unknown,
        };
        rows.push(row);
        add(summary.current, label(a));
        if (!b.stopped) add(summary.draft, label(b));
        if (!b.stopped) {
          const from = label(a);
          summary.transitions[from] ??= {};
          add(summary.transitions[from], label(b));
        }
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
  const grouped = groupedSessions(rows, k);
  summary.timing = timingOf(grouped, k, stopAfterHit);
  summary.jev.current = sumJev(rows, "current");
  summary.jev.draft = sumJev(rows, "draft");
  return { sessions: grouped, summary };
}
