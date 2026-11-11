import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { cutMiddle, prevCut, textCut, trimSpace, turnStates, userSaidDetailed, type Message } from "./textprep";
import { folderKey, type RuleRequest } from "./rules";
import { readClaude } from "./transcripts/claude";
import { readCodex } from "./transcripts/codex";
import { readPi } from "./transcripts/pi";
import { filesUnder, mapLimit, type Agent, type Transcript } from "./transcripts/common";

const agentNames: Agent[] = ["claude", "codex", "pi"];
export interface SamplePrep {
  originalChars: number; reminders: number; beforeRequestChars: number; wholeInjection: boolean;
  cut: { head: number; tail: number; marker: string; beforeChars: number; afterChars: number; truncated: boolean };
}
export interface Sample {
  id: string; agent: Agent; session: string; folder: string; time: string;
  text: string; fullText: string; prev: { user: string; reply: string };
  prep: SamplePrep;
  features: RuleRequest; transcript: string; message: number; routing?: { id: number; time: string; group?: string };
  initialMembers: Record<string, string>;
  parent?: string; subagentId?: string;
  prefixTokens: number; prefixEstimated: boolean;
}
export interface Filters {
  agents?: string | string[]; from?: string; to?: string; limit?: number;
  all?: boolean; sessions?: string[];
}
interface RouteTry {
  id?: string; model?: string; served?: string; status?: number; done?: boolean;
}
interface Route {
  id: number; agent: Agent; session?: string; folder?: string; time: string;
  sub?: string; subagentId?: string; kind?: string;
  group?: { id?: string; affinity?: string; members?: string[]; routing?: string };
  rule?: { tokens?: number; images?: boolean; compact?: boolean; effort?: string; folder?: string };
  model?: string; provider?: string; served?: string; tries?: RouteTry[];
  prompt?: { tokens?: number }; tokens?: number;
}
interface AgentStats {
  routingRecords: number; linkedRecords: number; transcripts: number; hitRate: number; turns: number; ambiguous: number; unmatchedTurns: number;
  skippedWithin: number;
}
export interface HistoryStats {
  routingRecords: number; linkedRecords: number; transcripts: number; turns: number;
  skippedWithin: number;
  malformedRouting: number; malformedTranscript: number; agents: Record<Agent, AgentStats>;
}
export interface HistoryResult { samples: Sample[]; stats: HistoryStats }
const parsed = new Map<string, { stamp: string; value: Promise<Transcript>; checkedAt: number }>();
export async function readTranscript(file: string, agent: Agent): Promise<Transcript> {
  return transcript(file, agent);
}
export const sessionId = (path: string): string => Buffer.from(path, "utf8").toString("base64url");
export const sessionPath = (id: string): string => Buffer.from(id, "base64url").toString("utf8");
const HELPER_PREFIX = "Name this chat from the user's first request";
const helperCalls = new WeakMap<Transcript, boolean>();
// Orca titles a chat by asking a one-turn model call. It is not a chat the
// user had, so it stays out of the catalog, search and replay.
export function isHelperCall(t: Transcript): boolean {
  const known = helperCalls.get(t);
  if (known !== undefined) return known;
  const helper = () => {
    if (t.agent !== "claude") return false;
    let first = "";
    for (const m of t.messages) {
      if (m.Role !== "user") continue;
      const said = userSaidDetailed(m).text;
      if (!said) continue;
      if (first) return false;
      first = said.trimStart();
      if (!first.startsWith(HELPER_PREFIX)) return false;
    }
    if (!first) return false;
    const states = turnStates(t.messages);
    let turns = 0;
    for (let i = 0; i < t.messages.length; i++) {
      if (t.messages[i].Role === "user" && userSaidDetailed(t.messages[i]).text && states[i].newTurn) turns++;
    }
    return turns === 1;
  };
  const value = helper();
  helperCalls.set(t, value);
  return value;
}
async function transcript(file: string, agent: Agent): Promise<Transcript> {
  const old = parsed.get(file);
  // Tens of thousands of routing rows point at the same few hundred
  // transcripts. One stat per file per short window keeps the catalog fast
  // without hiding a chat that is still being written.
  if (old && Date.now() - old.checkedAt < 15_000) return old.value;
  const info = await stat(file), stamp = `${info.size}:${info.mtimeMs}`;
  if (old?.stamp === stamp) {
    old.checkedAt = Date.now();
    return old.value;
  }
  const value = agent === "claude" ? readClaude(file) : agent === "codex" ? readCodex(file) : readPi(file);
  parsed.set(file, { stamp, value, checkedAt: Date.now() });
  try { return await value; } catch (err) { parsed.delete(file); throw err; }
}
async function piSessionId(file: string): Promise<string> {
  try {
    const text = await Bun.file(file).slice(0, 131_072).text();
    for (const line of text.split("\n", 2)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row?.type === "session" && typeof row.id === "string" && row.id) return row.id;
    }
  } catch { /* fall through to the file name */ }
  return basename(file).match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1] ?? "";
}
export function shortFolder(dir: string): string {
  let parts = trimSpace(dir).split(/[\\/]+/).filter(Boolean);
  if (parts[0]?.length === 2 && parts[0][1] === ":") parts = parts.slice(1);
  return parts.slice(-2).join("/");
}
function sameFolder(route: Route, t: Transcript): boolean {
  const dir = route.rule?.folder || route.folder || "";
  if (!dir || !t.cwd) return false;
  if (folderKey(dir)) return folderKey(dir) === folderKey(t.cwd);
  const a = shortFolder(dir), b = shortFolder(t.cwd);
  return process.platform === "darwin" || process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function range(filters: Filters) {
  const bound = (s: string | undefined, end: boolean) => {
    if (!s) return end ? Infinity : -Infinity;
    const n = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + (end ? "T23:59:59.999Z" : "T00:00:00.000Z") : s);
    if (!Number.isFinite(n)) throw new Error(`日期无效: ${s}`);
    return n;
  };
  const from = bound(filters.from, false), to = bound(filters.to, true);
  if (from > to) throw new Error("from 必须早于 to");
  const agents = typeof filters.agents === "string" ? filters.agents.split(",").filter(Boolean) : filters.agents;
  if (agents?.some(a => !agentNames.includes(a as Agent))) throw new Error("agents 只支持 claude,codex,pi");
  const limit = filters.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit 必须是 1…10000 的整数");
  return { from, to, agents: new Set(agents?.length ? agents : agentNames), limit };
}
async function readRouting(dir: string): Promise<{ routes: Route[]; malformed: number }> {
  let names: string[];
  try { names = await readdir(dir); } catch (err: any) { if (err.code === "ENOENT") return { routes: [], malformed: 0 }; throw err; }
  const rows = new Map<string, Route>();
  let malformed = 0;
  for (const name of names.filter(n => /\.jsonl(?:\.gz)?$/.test(n)).sort()) {
    const source = createReadStream(join(dir, name));
    const input = name.endsWith(".gz") ? source.pipe(createGunzip()) : source;
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row: Route;
        try { row = JSON.parse(line); } catch { malformed++; continue; }
        if (!row || !agentNames.includes(row.agent)) continue;
        if (!Number.isFinite(Date.parse(row.time))) { malformed++; continue; }
        // The same routing ID can appear while a request is updated. Keep its last row.
        rows.set(`${name.replace(/\.gz$/, "")}:${row.id ?? rows.size}`, row);
      }
    } finally { lines.close(); input.destroy(); source.destroy(); }
  }
  return { routes: [...rows.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)), malformed };
}
// The routing log's session key, as the transcript files use it: a Claude
// subagent has its own file, and Codex names its rollout by thread id.
function routeSessionKey(route: Route): string {
  if (route.agent === "claude") return route.subagentId || route.sub || route.session || "";
  return route.session || "";
}
function transcriptSessionKey(t: Transcript): string {
  return t.session;
}
// The account and model that actually served a routing row, as
// provider/model. A try's id names the account or key; a "#" or "@" suffix
// is one of its keys or accounts, not another member.
function routeMember(route: Route): string {
  const tries = (route.tries ?? []).filter((t): t is RouteTry => !!t);
  const served = typeof route.served === "string" ? route.served : "";
  const matching = tries.filter(t => !served || t.served === served || t.model === served);
  const pick = [...matching].reverse().find(t => t.served || t.status === 200)
    ?? [...tries].reverse().find(t => t.served || t.status === 200)
    ?? tries.at(-1);
  const model = pick?.served || pick?.model || served || "";
  const provider = pick?.id
    ? String(pick.id).split(/[@#]/)[0]
    : typeof route.provider === "string" ? route.provider : "";
  if (provider && model) return `${provider}/${model}`;
  const top = typeof route.model === "string" ? route.model : "";
  if (top.includes("/") && !top.startsWith("group/") && (!model || top.endsWith("/" + model))) return top;
  const member = route.group?.members?.find(m => m === model || m.endsWith("/" + model));
  return member || model;
}
function routeTokenCount(route: Route | undefined): number | null {
  const prompt = route?.prompt?.tokens;
  if (typeof prompt === "number" && Number.isFinite(prompt)) return prompt;
  const tokens = route?.tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null;
}
// The proxy for a turn's prefix when no routing row has prompt tokens. It
// counts every part the agent wrote into the transcript, not only prose.
function messageChars(m: Message): number {
  let chars = 0;
  for (const p of m.Parts) {
    if (p.Text) chars += Array.from(p.Text).length;
    if (p.Call) {
      if (typeof p.Call.input === "string") chars += Array.from(p.Call.input).length;
      else if (p.Call.input !== undefined) chars += JSON.stringify(p.Call.input).length;
      if (p.Call.output) chars += Array.from(p.Call.output).length;
    }
  }
  return chars;
}
function emptyStats(): HistoryStats {
  const agents = Object.fromEntries(agentNames.map(a => [a, { routingRecords: 0, linkedRecords: 0, transcripts: 0, hitRate: 0, turns: 0, ambiguous: 0, unmatchedTurns: 0, skippedWithin: 0 }])) as Record<Agent, AgentStats>;
  return { routingRecords: 0, linkedRecords: 0, transcripts: 0, turns: 0, skippedWithin: 0, malformedRouting: 0, malformedTranscript: 0, agents };
}
export async function readHistory(filters: Filters = {}, home = homedir()): Promise<HistoryResult> {
  const selected = range(filters), stats = emptyStats();
  const wantedPaths = filters.sessions?.length ? new Set(filters.sessions) : null;
  const routing = await readRouting(join(home, ".config/magpie/routing"));
  stats.malformedRouting = routing.malformed;
  const routes = routing.routes.filter(r => selected.agents.has(r.agent) && Date.parse(r.time) >= selected.from && Date.parse(r.time) <= selected.to);
  // A session's first answer and a turn's prompt size can lie just outside
  // the selected date range. Keep an index of all in-agent routing rows by
  // transcript key; only in-range rows feed the sample association above.
  const routeIndex = new Map<string, Route[]>();
  for (const route of routing.routes) {
    if (!selected.agents.has(route.agent)) continue;
    const key = routeSessionKey(route);
    if (!key) continue;
    const id = route.agent + "\0" + key;
    const list = routeIndex.get(id);
    if (list) list.push(route); else routeIndex.set(id, [route]);
  }
  const keep = (file: string) => !wantedPaths || wantedPaths.has(file);
  const files = await Promise.all([
    selected.agents.has("claude") ? filesUnder(join(home, ".claude/projects")) : [],
    selected.agents.has("codex") ? filesUnder(join(home, ".codex/sessions"), [".jsonl", ".jsonl.zst"]) : [],
    selected.agents.has("pi") ? filesUnder(join(home, ".pi/agent/sessions")) : [],
  ]);
  files[0] = files[0].filter(keep);
  files[1] = files[1].filter(keep);
  files[2] = files[2].filter(keep);
  const claudeFiles = new Map<string, string[]>();
  for (const file of files[0]) {
    const key = basename(file, ".jsonl");
    claudeFiles.set(key, [...(claudeFiles.get(key) ?? []), file]);
  }
  const codexFiles = new Map<string, string[]>();
  for (const file of files[1]) for (const key of basename(file).match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi) ?? []) {
    const list = codexFiles.get(key) ?? [];
    // A plain rollout and its compressed copy are one transcript. Keep the
    // plain one, and leave two same-format files to the ambiguity check.
    if (file.endsWith(".zst") && list.some(f => !f.endsWith(".zst"))) continue;
    if (!file.endsWith(".zst")) list.splice(0, list.length, ...list.filter(f => !f.endsWith(".zst")));
    list.push(file);
    codexFiles.set(key, list);
  }
  // A pi transcript names itself in its first session row; reading that is
  // far cheaper than parsing every session file just to match routing rows.
  const piPaths = new Map<string, string>();
  await mapLimit(files[2], 24, async file => {
    const id = await piSessionId(file);
    if (id && !piPaths.has(id)) piPaths.set(id, file);
  });
  const linked = new Map<string, { t: Transcript; routes: Route[] }>();
  await mapLimit(routes, 24, async route => {
    const s = stats.agents[route.agent]; s.routingRecords++; stats.routingRecords++;
    let candidates: Transcript[];
    if (route.agent === "pi") {
      const path = route.session ? piPaths.get(route.session) : undefined;
      candidates = path ? [await transcript(path, "pi")] : [];
    } else {
      const paths = route.agent === "claude"
        ? claudeFiles.get(route.subagentId || route.sub ? `agent-${route.subagentId || route.sub}` : route.session || "") ?? []
        : codexFiles.get(route.session || "") ?? [];
      candidates = await Promise.all(paths.map(p => transcript(p, route.agent)));
      if (candidates.length > 1) candidates = candidates.filter(t => sameFolder(route, t));
    }
    if (candidates.length > 1) { s.ambiguous++; return; }
    if (candidates.length !== 1) return;
    const t = candidates[0];
    if (isHelperCall(t)) return;
    if (t.agent === "codex" && t.parentKey && !t.parentPath) {
      t.parentPath = codexFiles.get(t.parentKey)?.[0];
    }
    s.linkedRecords++; stats.linkedRecords++;
    const old = linked.get(t.path);
    if (old) old.routes.push(route); else linked.set(t.path, { t, routes: [route] });
  });
  // A selected subagent may have no routing rows of its own; it still has
  // turns to replay, with an unknown initial member.
  if (wantedPaths) {
    const agentOfPath = new Map<string, Agent>();
    files[0].forEach(path => agentOfPath.set(path, "claude"));
    files[1].forEach(path => agentOfPath.set(path, "codex"));
    files[2].forEach(path => agentOfPath.set(path, "pi"));
    for (const path of wantedPaths) {
      if (linked.has(path)) continue;
      const agent = agentOfPath.get(path);
      if (!agent) continue;
      const t = await transcript(path, agent);
      if (isHelperCall(t)) continue;
      if (t.agent === "codex" && t.parentKey && !t.parentPath) {
        t.parentPath = codexFiles.get(t.parentKey)?.[0];
      }
      linked.set(path, { t, routes: [] });
    }
  }
  let all: Sample[] = [];
  for (const { t, routes: attached } of linked.values()) {
    const s = stats.agents[t.agent]; s.transcripts++; stats.transcripts++; stats.malformedTranscript += t.malformed;
    attached.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const sessionKey = transcriptSessionKey(t);
    const sessionRoutes = ((sessionKey ? routeIndex.get(t.agent + "\0" + sessionKey) : undefined) ?? attached)
      .slice().sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const initialMembers: Record<string, string> = {};
    for (const route of sessionRoutes) {
      const group = route.group?.id ?? "";
      if (group in initialMembers) continue;
      const member = routeMember(route);
      if (member) initialMembers[group] = member;
    }
    const turns: { sample: Sample; at: number; prefixChars: number }[] = [];
    const skipped: number[] = [];
    const states = turnStates(t.messages);
    let previousUser = "", lastAssistant = "", prefixChars = 0;
    for (let i = 0; i < t.messages.length; i++) {
      const m = t.messages[i];
      prefixChars += messageChars(m);
      if (m.Role === "assistant") {
        const text = m.Parts.filter(p => p.Kind === "text").map(p => trimSpace(p.Text ?? "")).filter(Boolean).join("\n");
        if (text) lastAssistant = text;
        continue;
      }
      if (m.Role !== "user") continue;
      const said = userSaidDetailed(m);
      const text = said.text;
      if (!text) continue;
      const reply = lastAssistant;
      if (!states[i].newTurn) {
        // magpie's turnIn keeps this user message inside the previous turn;
        // it is not a sample, but it is still the last thing the user said
        // and so becomes the previous turn's context for the next sample.
        skipped.push(Date.parse(m.time));
        previousUser = text;
        lastAssistant = "";
        continue;
      }
      const runes = Array.from(reply);
      const beforeChars = Array.from(text).length;
      const cut = cutMiddle(text, textCut.head, textCut.tail);
      const sample: Sample = {
        id: createHash("sha256").update(t.agent + "\0" + t.path + "\0" + m.id).digest("hex").slice(0, 24),
        agent: t.agent, session: t.path, folder: m.cwd || t.cwd, time: m.time,
        text: cut, fullText: text,
        prep: {
          originalChars: said.originalChars, reminders: said.reminders,
          beforeRequestChars: said.beforeRequestChars, wholeInjection: said.wholeInjection,
          cut: {
            head: textCut.head, tail: textCut.tail, marker: textCut.marker,
            beforeChars, afterChars: Array.from(cut).length, truncated: beforeChars > textCut.head + textCut.tail,
          },
        },
        prev: {
          user: cutMiddle(previousUser, prevCut.userHead, prevCut.userTail),
          reply: runes.length > prevCut.replyTail ? prevCut.replyPrefix + runes.slice(-prevCut.replyTail).join("") : reply,
        },
        features: { agent: t.agent, folder: m.cwd || t.cwd, time: m.time, message: text },
        transcript: t.path, message: i,
        initialMembers,
        parent: t.parentPath, subagentId: t.subagentId,
        prefixTokens: 0, prefixEstimated: true,
      };
      turns.push({ sample, at: Date.parse(m.time), prefixChars });
      previousUser = text; lastAssistant = "";
    }
    for (const { sample, at, prefixChars: chars } of turns) {
      const route = sessionRoutes.find(r => Date.parse(r.time) >= at);
      const tokens = routeTokenCount(route);
      sample.prefixTokens = tokens ?? Math.max(1, Math.ceil(chars / 4));
      sample.prefixEstimated = tokens === null;
    }
    for (const at of skipped) {
      if (at < selected.from || at > selected.to) continue;
      s.skippedWithin++; stats.skippedWithin++;
    }
    // Attach each routing row only to the last user turn already present at its
    // timestamp. The first rule decision of that turn owns its request features.
    for (const r of attached) {
      const at = Date.parse(r.time);
      let lo = 0, hi = turns.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (turns[mid].at <= at) lo = mid + 1; else hi = mid; }
      const sample = turns[lo - 1]?.sample;
      if (!sample || sample.routing) continue;
      sample.routing = { id: r.id, time: r.time, group: r.group?.id };
      sample.features.time = r.time;
      if (t.agent === "claude") sample.features.subagent = !!(r.subagentId || r.sub);
      if (r.rule) {
        if (typeof r.rule.tokens === "number") sample.features.tokens = r.rule.tokens;
        sample.features.images = r.rule.images ?? false;
        sample.features.compact = r.rule.compact ?? false;
        if (r.rule.effort) {
          sample.features.effort = r.rule.effort === "on" ? "" : r.rule.effort;
          sample.features.thinking = true;
          sample.features.off = false;
        }
      }
    }
    for (const { sample, at } of turns) {
      if (at < selected.from || at > selected.to) continue;
      s.turns++; stats.turns++;
      if (!sample.routing) s.unmatchedTurns++;
      all.push(sample);
    }
  }
  if (wantedPaths) all = all.filter(sample => wantedPaths.has(sample.session));
  for (const s of Object.values(stats.agents)) s.hitRate = s.routingRecords ? s.linkedRecords / s.routingRecords : 0;
  all.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  return { samples: filters.all || wantedPaths ? all : all.slice(-selected.limit), stats };
}
