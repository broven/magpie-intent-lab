import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Before } from "./textprep";

// String constants and decision semantics: gateway/decide.go:37-427.
export const jevSure = 0.4;
export const levelSure = 0.5;
export const noIntent = "none of these";
export const jevLevels = [
  ["low", "Little to think about: a greeting, a question answered from what is already known, a mechanical or one-line change, running a command"],
  ["medium", "Some thought: an ordinary bug fix or a small feature in code already understood"],
  ["high", "Careful thought: a change across several files, a bug whose cause is not known yet, a design choice with trade-offs"],
  ["xhigh", "Deep thought: a subtle bug (concurrency, performance, security), an architecture or algorithm to design, a long multi-step plan"],
];
export const levelWork = [
  "little work: a question, an explanation, a one-line or mechanical change, a command to run",
  "some work: an ordinary bug fix or a small feature in code already understood",
  "much work: a change across several files, a bug whose cause is not known yet, a design choice",
  "the most work: a new program, app or game, an architecture, a long multi-step plan",
];
export interface Verdict { intent: string; said: string; topic: boolean; sure: number; effort: string; score: number }
export interface JevAnswer { model?: string; answers?: Record<string, { choice?: string; score?: number; noul?: number; confidence?: number; probabilities?: Record<string, unknown> }>; [key: string]: unknown }
export interface Levelling { levels: boolean; work: Record<string, string> | null; cached?: boolean }
export interface JevMeter { requests: number; hits: number }
export const emptyVerdict = (): Verdict => ({ intent: "", said: "", topic: false, sure: 0, effort: "", score: 0 });

export function Confidence(ps: Record<string, unknown> = {}): number {
  const values = Object.values(ps).filter((v): v is number => typeof v === "number");
  if (values.length < 2) return 1;
  return Math.max(0, (Math.max(0, ...values) - 1 / values.length) / (1 - 1 / values.length));
}
export function sureOf(confidence = 0, ps: Record<string, unknown> = {}): number {
  return Object.values(ps).filter(v => typeof v === "number").length < 2 ? confidence : Confidence(ps);
}
export function levelsOf(intents: string[], scores: number[]): Record<string, string> | null {
  if (intents.length < 2 || scores.length !== intents.length) return null;
  const order = intents.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const owns = intents.map(() => [] as string[]);
  levelWork.forEach((what, w) => {
    let near = 0;
    intents.forEach((_, i) => { if (Math.abs(scores[i] - w) < Math.abs(scores[near] - w)) near = i; });
    owns[near].push(what);
  });
  const out: Record<string, string> = Object.create(null);
  order.forEach((i, pos) => {
    let at = `Level ${pos + 1} of ${intents.length}, lowest first`;
    if (pos === 0) at = "The lowest level";
    else if (pos === intents.length - 1) at = "The highest level";
    if (owns[i].length) at += ": " + owns[i].join("; ");
    out[intents[i]] = at;
  });
  return out;
}
export function priorAsk(prev: Before): string {
  const keys: string[] = [];
  if (prev.User) keys.push("`previous_user_message` (the user's message before it)");
  if (prev.Reply) keys.push("`previous_assistant_reply` (the assistant's last reply before it)");
  if (!keys.length) return "";
  return " " + keys.join(" and ") + " are context only: judge the `message`, and when it is short or vague (go on, yes, fix that, 继续) judge the work it asks for in that context.";
}
export function intentAsk(prev: Before): string {
  let q = "The `message` is what a user asked a coding assistant. Which kind of request fits it best?";
  if (prev.Intent) q += " A message that only carries on from the user's message before it (go on, yes, do it, fix that) is of `previous_message_kind`; one that asks for something of its own is of the kind that fits it.";
  return q + priorAsk(prev);
}
export function levelAsk(prev: Before, work: boolean): string {
  let q = intentAsk(prev);
  if (work) q += " The kinds are levels of how much work a request is: judge the work the message asks for, not how short it is — a few words can ask for a whole program.";
  return q;
}
export function effortAsk(prev: Before): string {
  let q = "How much reasoning does a coding assistant need to handle the `message` well?";
  if (prev.Effort) q += " A message that only carries on from the user's message before it (go on, yes, do it) needs what that one did, `previous_message_reasoning` (low, medium, high or xhigh).";
  return q + priorAsk(prev);
}
export function jevState(prev: Before, effort: boolean, text: string): Record<string, string> {
  const st: Record<string, string> = { message: text };
  if (prev.Intent) st.previous_message_kind = prev.Intent;
  if (effort && prev.Effort) st.previous_message_reasoning = prev.Effort;
  if (prev.User) st.previous_user_message = prev.User;
  if (prev.Reply) st.previous_assistant_reply = prev.Reply;
  return st;
}
export function jevBody(model: string, intents: string[], work: Record<string, string> | null, prev: Before, effort: boolean, text: string) {
  const questions: Record<string, unknown> = {};
  if (intents.length) {
    const criteria: Record<string, unknown> = Object.create(null);
    criteria[noIntent] = "The message is none of the other kinds";
    const levels: Record<string, unknown> = Object.create(null);
    for (const intent of intents) {
      criteria[intent] = null;
      levels[intent] = work && Object.hasOwn(work, intent) ? work[intent] : null;
    }
    questions.intent = { type: "choice", instructions: intentAsk(prev), criteria };
    if (intents.length > 1) questions.level = { type: "choice", instructions: levelAsk(prev, work !== null), criteria: levels };
  }
  if (effort) questions.effort = { type: "score", instructions: effortAsk(prev), criteria: jevLevels.map(l => l[1]) };
  return { model, state: jevState(prev, effort, text), questions };
}
export function readJev(input: string | JevAnswer, intents: string[], levels: boolean, prev: Before): Verdict {
  let out: JevAnswer;
  try {
    out = typeof input === "string" ? JSON.parse(input) : input;
    if (!out || typeof out !== "object" || Array.isArray(out) || (out.answers != null && (typeof out.answers !== "object" || Array.isArray(out.answers)))) throw Error();
    for (const a of Object.values(out.answers ?? {})) {
      if (a === null) continue;
      if (typeof a !== "object" || Array.isArray(a)) throw Error();
      for (const key of ["score", "confidence"] as const) if (a[key] != null && typeof a[key] !== "number") throw Error();
      if (a.choice != null && typeof a.choice !== "string") throw Error();
      if (a.probabilities != null && (typeof a.probabilities !== "object" || Array.isArray(a.probabilities))) throw Error();
    }
  } catch { throw new Error("not a System One answer"); }
  const v = emptyVerdict();
  const answers = out.answers ?? {};
  const named = (s: string) => intents.includes(s) ? s : "";
  if (Object.hasOwn(answers, "intent") && intents.length && !levels) {
    const a = answers.intent ?? {};
    v.sure = sureOf(a.confidence ?? 0, a.probabilities ?? {});
    v.said = a.choice ?? "";
    v.topic = true;
    if (v.said !== noIntent) v.intent = named(v.said);
  }
  if (Object.hasOwn(answers, "level") && intents.length && levels) {
    const a = answers.level ?? {};
    v.sure = sureOf(a.confidence ?? 0, a.probabilities ?? {});
    v.said = a.choice ?? "";
    v.intent = named(v.said);
    const was = named(prev.Intent ?? "");
    if (v.sure < jevSure && was) v.intent = was;
  }
  if (Object.hasOwn(answers, "effort")) {
    const score = answers.effort?.score ?? 0;
    v.effort = jevLevels[Math.max(0, Math.min(Math.round(score), jevLevels.length - 1))][0];
    v.score = score;
  }
  return v;
}
export function intentOf(v: Verdict, group: { intentSure?: number | null }): string {
  if (!v.topic) return v.intent;
  return v.sure < (group.intentSure ?? jevSure) || v.said === noIntent || !v.intent ? "" : v.intent;
}

// Stable request bytes make current/draft and subsequent runs share cache entries.
export function requestBytes(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(requestBytes).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + requestBytes(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < 4) active++; else await new Promise<void>(resolve => waiting.push(resolve));
  try { return await fn(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
}
interface DiskCache { answers: Map<string, JevAnswer>; loaded: Promise<void>; writing: Promise<void> }
const disks = new Map<string, DiskCache>();
function diskCache(file: string): DiskCache {
  const previous = disks.get(file);
  if (previous) return previous;
  const entry: DiskCache = { answers: new Map(), loaded: Promise.resolve(), writing: Promise.resolve() };
  entry.loaded = (async () => {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch (err: any) { if (err.code === "ENOENT") return; throw err; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.key === "string" && row.answer && typeof row.answer === "object") entry.answers.set(row.key, row.answer);
      } catch { /* An interrupted last append is not an answer. */ }
    }
  })();
  disks.set(file, entry);
  return entry;
}
const pending = new Map<string, Promise<JevAnswer>>();
export class JevClient {
  readonly file: string;
  readonly url: string;
  readonly stats = { requests: 0, hits: 0 };
  private levellings = new Map<string, Promise<Levelling>>();
  constructor(options: { addr?: string; dir?: string } = {}) {
    this.file = join(options.dir ?? process.env.INTENT_LAB_DIR ?? join(homedir(), ".config/magpie/intent-lab"), "cache.jsonl");
    this.url = "http://" + (options.addr ?? process.env.MAGPIE_ADDR ?? "127.0.0.1:3425") + "/v1/systemone";
  }
  async systemOne(body: unknown, meta?: { cached?: boolean }, meter?: JevMeter): Promise<JevAnswer> {
    const bytes = requestBytes(body);
    const key = createHash("sha256").update(bytes).digest("hex");
    const disk = diskCache(this.file);
    await disk.loaded;
    const cached = disk.answers.get(key);
    if (cached) { this.stats.hits++; if (meter) meter.hits++; if (meta) meta.cached = true; return cached; }
    const flightKey = this.file + "\0" + this.url + "\0" + key;
    const flight = pending.get(flightKey);
    if (flight) { this.stats.hits++; if (meter) meter.hits++; if (meta) meta.cached = true; return flight; }
    const call = slot(async () => {
      this.stats.requests++;
      if (meter) meter.requests++;
      const res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: bytes, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const answer = await res.json() as JevAnswer;
      if (!answer || !answer.answers || typeof answer.answers !== "object" || Array.isArray(answer.answers)) throw new Error("not a System One answer");
      if (meta) meta.cached = false;
      const write = disk.writing.then(async () => {
        await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
        await appendFile(this.file, JSON.stringify({ key, answer }) + "\n", { mode: 0o600 });
      });
      disk.writing = write.catch(() => {});
      // The cache is an optimization: a read-only or full disk must not
      // throw away an answer the gateway already gave.
      try { await write; disk.answers.set(key, answer); } catch { /* answer is still usable */ }
      return answer;
    });
    pending.set(flightKey, call);
    try { return await call; } finally { pending.delete(flightKey); }
  }
  async jevLevelled(model: string, intents: string[], meta?: { cached?: boolean }, meter?: JevMeter): Promise<Levelling> {
    const key = model + "\0" + intents.join("\0").toLowerCase();
    const old = this.levellings.get(key);
    if (old) {
      if (meta) meta.cached = true;
      const value = await old;
      return { levels: value.levels, work: value.work, cached: true };
    }
    const call = (async () => {
      const questions: Record<string, unknown> = { levels: { type: "noul", instructions: "Are these `kinds` levels of one scale that every request to a coding assistant is at, such as how hard, how big or how urgent it is — rather than topics or tasks that a request may be none of?" } };
      intents.forEach((_, i) => { questions[`work${i}`] = { type: "score", instructions: `Taking \`kinds\` as levels of one scale for requests to a coding assistant, how much work is a request at the level \`kinds[${i}]\`?`, criteria: levelWork }; });
      const answer = await this.systemOne({ model, state: { kinds: intents }, questions }, meta, meter);
      const noul = answer.answers?.levels?.noul;
      if (typeof noul !== "number") throw new Error("not a System One answer");
      const levels = noul >= levelSure;
      const scores = intents.map((_, i) => answer.answers?.[`work${i}`]?.score).filter((v): v is number => typeof v === "number");
      return { levels, work: levels ? levelsOf(intents, scores) : null, cached: meta?.cached };
    })();
    this.levellings.set(key, call);
    try { return await call; } catch (err) { this.levellings.delete(key); throw err; }
  }
  async askJev(model: string, intents: string[], prev: Before, text: string, meter?: JevMeter) {
    const probe: { cached?: boolean } = {};
    const levelling: Levelling = intents.length > 1
      ? await this.jevLevelled(model, intents, probe, meter)
      : { levels: false, work: null };
    const body = jevBody(model, intents, levelling.work, prev, false, text);
    const meta: { cached?: boolean } = {};
    const raw = await this.systemOne(body, meta, meter);
    return {
      verdict: readJev(raw, intents, levelling.levels, prev), raw, body, levels: levelling.levels,
      cached: !!meta.cached,
      levelProbe: { levels: levelling.levels, work: levelling.work, cached: !!probe.cached || !!levelling.cached },
    };
  }
}
