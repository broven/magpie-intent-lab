import { intentOf, type Before, type JevClient, type Verdict } from "./jev";
import { Intents, MatchRule, unknownForRules, type Group, type Rule, type RuleRequest } from "./rules";
import type { Sample } from "./history";

export interface SideResult {
  intent: string; said: string; sure: number; rule: number; use: string;
}
export interface UnknownCond { side: "current" | "draft"; rule: number; condition: string }
export interface Row {
  id: string; agent: string; folder: string; time: string; text: string; fullText: string;
  prev: { user: string; reply: string };
  current: SideResult; draft: SideResult;
  changed: boolean; unknownConds: UnknownCond[];
  currentRaw?: unknown; draftRaw?: unknown;
  currentBody?: unknown; draftBody?: unknown;
  currentLevels?: boolean; draftLevels?: boolean;
}
export interface Summary {
  current: Record<string, number>; draft: Record<string, number>;
  transitions: Record<string, Record<string, number>>; changed: number;
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

function pick(rules: Rule[], q: RuleRequest): SideResult {
  const rule = MatchRule(rules, q);
  return {
    intent: q.intent ?? "",
    said: "",
    sure: 0,
    rule: rule < 0 ? 0 : rule + 1,
    use: rule < 0 ? "" : rules[rule].use,
  };
}

async function side(jev: JevClient, model: string, state: Side, sample: Sample): Promise<{ result: SideResult; raw?: unknown; body?: unknown; levels?: boolean }> {
  const session = sample.session;
  const prior = state.prev.get(session) ?? "";
  const q: RuleRequest = { ...sample.features, message: sample.fullText };
  const candidates = Intents(state.rules, q);
  const before: Before = { User: sample.prev.user || undefined, Reply: sample.prev.reply || undefined };
  if (prior && candidates.includes(prior)) before.Intent = prior;
  let verdict: Verdict;
  let raw: unknown, body: unknown, levels: boolean | undefined;
  if (!candidates.length) {
    verdict = { intent: "", said: "", topic: false, sure: 0, effort: "", score: 0 };
  } else {
    const asked = await jev.askJev(model, candidates, before, sample.text);
    verdict = asked.verdict;
    raw = asked.raw; body = asked.body; levels = asked.levels;
  }
  const intent = intentOf(verdict, { intentSure: state.intentSure });
  q.intent = intent;
  const result = pick(state.rules, q);
  result.said = verdict.said;
  result.sure = verdict.sure;
  // A named level is still one of this turn's intents, as upstream carries
  // c.Intent (rules.go:331-340); "none of these" carries nothing.
  if (intent) state.prev.set(session, intent);
  else state.prev.delete(session);
  return { result, raw, body, levels };
}

export async function replay(jev: JevClient, group: Group, current: Group, draft: Group, samples: Sample[], progress?: (done: number, total: number) => void): Promise<RunResult> {
  const currentState: Side = { prev: new Map(), rules: current.rules, intentSure: current.intentSure };
  const draftState: Side = { prev: new Map(), rules: draft.rules, intentSure: draft.intentSure };
  const rows: Row[] = [];
  const summary: Summary = { current: {}, draft: {}, transitions: {}, changed: 0 };
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
          id: sample.id, agent: sample.agent, folder: sample.folder, time: sample.time,
          text: sample.text, fullText: sample.fullText, prev: sample.prev,
          current: a.result, draft: b.result,
          changed: a.result.intent !== b.result.intent || a.result.use !== b.result.use || a.result.rule !== b.result.rule,
          unknownConds: unknown,
          currentRaw: a.raw, draftRaw: b.raw, currentBody: a.body, draftBody: b.body,
          currentLevels: a.levels, draftLevels: b.levels,
        };
        rows.push(row);
        add(summary.current, label(a.result));
        add(summary.draft, label(b.result));
        const from = label(a.result);
        summary.transitions[from] ??= {};
        add(summary.transitions[from], label(b.result));
        if (row.changed) summary.changed++;
        done++;
        progress?.(done, samples.length);
      }
    }
  });
  await Promise.all(workers);
  rows.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  return { rows, summary };
}
