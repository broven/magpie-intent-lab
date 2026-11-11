import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { assistantSaid, cutMiddle, trimSpace, turnStates, userSaidDetailed } from "./textprep";
import { isHelperCall, readHistory, readTranscript, sessionId, sessionPath, type Filters, type Sample } from "./history";
import { sessionFiles, subagentsOf, type SessionFile } from "./sessiontree";
import { bashEvents, type BashEvent } from "./transcripts/bash";
import { mapLimit, type Agent, type Transcript } from "./transcripts/common";

export type SearchScope = "first" | "user" | "reply" | "bash";
export const searchScopes: SearchScope[] = ["first", "user", "reply", "bash"];

export interface SearchSnippet {
  scope: SearchScope;
  text: string;
  start: number;
  end: number;
  lead: boolean;
  trail: boolean;
  subagent?: string;
}
export interface SessionSummary {
  id: string;
  agent: Agent;
  folder: string;
  start: string;
  end: string;
  lastTurn: string;
  first: string;
  hits: number;
  snippets: SearchSnippet[];
  turns: number;
  subagents: number;
}
export interface SessionSearch {
  q?: string;
  regex?: boolean;
  scopes?: string | string[];
  agents?: string | string[];
  from?: string;
  to?: string;
  limit?: number;
}
export interface SessionSearchResult {
  sessions: SessionSummary[];
  durationMs: number;
  stats?: unknown;
}
export interface PreviewItem {
  kind: "user" | "assistant" | "bash";
  time: string;
  text?: string;
  command?: string;
  output?: string;
  name?: string;
  sampleId?: string;
  message?: number;
}
export interface PreviewSubagent {
  id: string;
  subagentId: string;
  agent: Agent;
  first: string;
  start: string;
  end: string;
  turnCount: number;
}
export interface SessionPreview {
  id: string;
  agent: Agent;
  folder: string;
  start: string;
  end: string;
  first: string;
  turnCount: number;
  items: PreviewItem[];
  focus: number;
  subagents: PreviewSubagent[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A search and its follow-up scopes usually arrive together. Keep the
// linked-session result briefly so the second query does not reread routing
// and every transcript; transcript parsing itself stays mtime-cached.
const historyCache = new Map<string, { at: number; value: ReturnType<typeof readHistory> }>();
// A catalog read parses every transcript; keep it warm across a search and
// its follow-up scopes. Transcript parsing itself stays mtime-cached.
const HISTORY_TTL = 5 * 60_000;
// Build every scope's searchable text for every transcript. The start-up
// warm-up does this in the background so the first full-scope search is not
// the one paying for user/reply/bash extraction.
export async function warmSearchTexts(home = homedir()): Promise<void> {
  const history = await historyFor({ limit: 10_000, all: true }, home);
  const index = await sessionFiles(home);
  const seen = new Set<string>();
  const warm = async (path: string, agent: Agent) => {
    if (seen.has(path)) return;
    seen.add(path);
    try {
      const t = await readTranscript(path, agent);
      for (const scope of searchScopes) textsFor(t, scope);
    } catch { /* one unreadable file must not stop the rest */ }
  };
  for (const sample of history.samples) await warm(sample.session, sample.agent);
  for (const file of index) await warm(file.path, file.agent);
}
export async function historyFor(filters: Filters, home = homedir()) {
  const key = JSON.stringify([filters.agents ?? "", filters.from ?? "", filters.to ?? "", home]);
  const old = historyCache.get(key);
  if (old && Date.now() - old.at < HISTORY_TTL) {
    old.at = Date.now();
    return old.value;
  }
  // The promise is kept, not its value: a search made while the start-up
  // warm-up is still reading shares that read instead of doing it again.
  const value = readHistory(filters, home);
  historyCache.set(key, { at: Date.now(), value });
  try { return await value; } catch (err) { historyCache.delete(key); throw err; }
}
function matcher(q: string, regex: boolean): RegExp {
  if (regex) return new RegExp(q, "gi");
  return new RegExp(escapeRegExp(q), "gi");
}
function matches(text: string, re: RegExp): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  re.lastIndex = 0;
  for (;;) {
    const hit = re.exec(text);
    if (!hit) break;
    out.push({ start: hit.index, end: hit.index + hit[0].length });
    if (!hit[0].length) re.lastIndex++;
    if (re.lastIndex > text.length) break;
  }
  return out;
}
function snippet(text: string, hit: { start: number; end: number }, scope: SearchScope, subagent?: string): SearchSnippet {
  const start = Math.max(0, hit.start - 90), end = Math.min(text.length, hit.end + 90);
  return {
    scope,
    text: text.slice(start, end),
    start: hit.start - start,
    end: hit.end - start,
    lead: start > 0,
    trail: end < text.length,
    ...(subagent ? { subagent } : {}),
  };
}
function clip(text: string, limit: number): string {
  const runes = Array.from(text);
  return runes.length > limit ? runes.slice(0, limit).join("") + "\n…\n" : text;
}
function scopesOf(value: string | string[] | undefined): Set<SearchScope> {
  const raw = typeof value === "string" ? value.split(",") : value ?? [];
  const chosen = raw.map(s => trimSpace(s).toLowerCase()).filter(Boolean);
  if (!chosen.length) return new Set<SearchScope>(["first"]);
  for (const scope of chosen) if (!searchScopes.includes(scope as SearchScope)) throw new Error(`未知搜索范围: ${scope}`);
  return new Set(chosen as SearchScope[]);
}
function range(filters: { from?: string; to?: string }): { from: number; to: number } {
  const bound = (s: string | undefined, end: boolean) => {
    if (!s) return end ? Infinity : -Infinity;
    const n = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + (end ? "T23:59:59.999Z" : "T00:00:00.000Z") : s);
    if (!Number.isFinite(n)) throw new Error(`日期无效: ${s}`);
    return n;
  };
  const from = bound(filters.from, false), to = bound(filters.to, true);
  if (from > to) throw new Error("from 必须早于 to");
  return { from, to };
}
function sampleIdFor(agent: Agent, path: string, messageId: string): string {
  return createHash("sha256").update(agent + "\0" + path + "\0" + messageId).digest("hex").slice(0, 24);
}
function firstUser(t: Transcript): string {
  for (const m of t.messages) {
    if (m.Role !== "user") continue;
    const said = userSaidDetailed(m).text;
    if (said) return said;
  }
  return "";
}
const textCache = new WeakMap<Transcript, Map<SearchScope, { scope: SearchScope; text: string }[]>>();
function textsFor(t: Transcript, scope: SearchScope): { scope: SearchScope; text: string }[] {
  let byScope = textCache.get(t);
  if (!byScope) { byScope = new Map(); textCache.set(t, byScope); }
  const old = byScope.get(scope);
  if (old) return old;
  const out: { scope: SearchScope; text: string }[] = [];
  if (scope === "first") {
    const text = firstUser(t);
    if (text) out.push({ scope, text });
  } else if (scope === "user") {
    for (const m of t.messages) {
      if (m.Role !== "user") continue;
      const text = userSaidDetailed(m).text;
      if (text) out.push({ scope, text });
    }
  } else if (scope === "reply") {
    for (const m of t.messages) {
      if (m.Role !== "assistant") continue;
      const text = assistantSaid(m);
      if (text) out.push({ scope, text });
    }
  } else {
    for (const event of bashEvents(t)) {
      if (event.command) out.push({ scope, text: clip(event.command, 4000) });
      if (event.output) out.push({ scope, text: clip(event.output, 4000) });
    }
  }
  byScope.set(scope, out);
  return out;
}
function searchTexts(t: Transcript, scopes: Set<SearchScope>): { scope: SearchScope; text: string }[] {
  return [...scopes].flatMap(scope => textsFor(t, scope));
}

export async function searchSessions(query: SessionSearch, home = homedir()): Promise<SessionSearchResult> {
  const started = performance.now();
  const q = trimSpace(query.q ?? "");
  const selected = range(query);
  const scopes = q ? scopesOf(query.scopes) : new Set<SearchScope>();
  let re: RegExp | null = null;
  if (q) {
    try { re = matcher(q, !!query.regex); } catch (err: any) { throw new Error(`正则无效: ${err?.message ?? err}`); }
  }
  const limit = query.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit 必须是 1…1000 的整数");
  // The catalog always reads every turn of a session. A date range picks the
  // sessions by their last turn; it must not cut the replayed session short.
  const history = await historyFor({ agents: query.agents, limit: 10_000, all: true }, home);
  const index = await sessionFiles(home);
  const byPath = new Map(index.map(file => [file.path, file]));
  const rootCache = new Map<string, string>();
  const rootOf = (path: string): string => {
    const cached = rootCache.get(path);
    if (cached !== undefined) return cached;
    let file = byPath.get(path), root = "";
    if (!file) { rootCache.set(path, ""); return ""; }
    const seen = new Set<string>();
    while (file.parentPath && !seen.has(file.path)) {
      seen.add(file.path);
      const parent = byPath.get(file.parentPath);
      if (!parent) { root = file.parentPath; break; }
      file = parent;
    }
    if (!root) root = file.path;
    rootCache.set(path, root);
    return root;
  };
  const filesByRoot = new Map<string, SessionFile[]>();
  for (const file of index) {
    const root = rootOf(file.path);
    if (!root) continue;
    const list = filesByRoot.get(root);
    if (list) list.push(file); else filesByRoot.set(root, [file]);
  }
  const byRoot = new Map<string, Sample[]>();
  for (const sample of history.samples) {
    const root = rootOf(sample.session);
    if (!root) continue;
    const list = byRoot.get(root);
    if (list) list.push(sample); else byRoot.set(root, [sample]);
  }
  const sessions: SessionSummary[] = [];
  for (const [root, samples] of byRoot) {
    const rootFile = byPath.get(root);
    // An orphan subagent has no main session to show; never list its path.
    if (!rootFile || rootFile.parentPath) continue;
    const own = samples.filter(sample => sample.session === root);
    if (!own.length) continue;
    const subs = (filesByRoot.get(root) ?? []).filter(file => file.path !== root);
    let lastTurn = own[0].time;
    for (const sample of samples) if (sample.time > lastTurn) lastTurn = sample.time;
    // A subagent with no routing samples still has turns; its file time keeps
    // the entry's "last turn" honest without parsing every subagent.
    for (const sub of subs) if (sub.mtime && sub.mtime > lastTurn) lastTurn = sub.mtime;
    const at = Date.parse(lastTurn);
    if (!(at >= selected.from && at <= selected.to)) continue;
    const agent = rootFile.agent;
    const t = await readTranscript(root, agent);
    if (isHelperCall(t)) continue;
    let hits = 0;
    const snippets: SearchSnippet[] = [];
    if (q && re) {
      const targets: { t: Transcript; subagent?: string }[] = [{ t }];
      for (const sub of subs) {
        try {
          const child = await readTranscript(sub.path, sub.agent);
          if (!isHelperCall(child)) targets.push({ t: child, subagent: sub.subagentId ?? sub.key });
        } catch { /* a broken subagent must not hide its parent */ }
      }
      for (const target of targets) {
        for (const item of searchTexts(target.t, scopes)) {
          const found = matches(item.text, re);
          hits += found.length;
          for (const hit of found) {
            if (snippets.length < 3) snippets.push(snippet(item.text, hit, item.scope, target.subagent));
          }
        }
      }
      if (!hits) continue;
    }
    const first = firstUser(t);
    sessions.push({
      id: sessionId(root), agent, folder: t.cwd || own[0].folder,
      start: t.start ? new Date(t.start).toISOString() : own[0].time,
      end: t.end ? new Date(t.end).toISOString() : lastTurn,
      lastTurn,
      first: cutMiddle(first, 240, 0),
      hits, snippets, turns: own.length, subagents: subs.length,
    });
  }
  sessions.sort((a, b) => (q ? b.hits - a.hits : 0) || b.lastTurn.localeCompare(a.lastTurn) || a.id.localeCompare(b.id));
  return {
    sessions: sessions.slice(0, limit),
    durationMs: Math.round(performance.now() - started),
    stats: history.stats,
  };
}

function agentForPath(path: string, home: string): Agent | null {
  const roots: [Agent, string][] = [
    ["claude", join(home, ".claude/projects")],
    ["codex", join(home, ".codex/sessions")],
    ["pi", join(home, ".pi/agent/sessions")],
  ];
  const full = resolve(path);
  for (const [agent, root] of roots) {
    const base = resolve(root);
    if (full === base || full.startsWith(base + sep)) return agent;
  }
  return null;
}

export async function sessionPreview(
  id: string,
  options: { from?: string; to?: string; sample?: string } = {},
  home = homedir(),
): Promise<SessionPreview> {
  const path = sessionPath(id);
  const agent = agentForPath(path, home);
  if (!agent) throw new Error("未知会话");
  const selected = range(options);
  const t = await readTranscript(path, agent);
  const states = turnStates(t.messages);
  const items: PreviewItem[] = [];
  for (let i = 0; i < t.messages.length; i++) {
    const m = t.messages[i];
    if (m.Role === "user") {
      const text = userSaidDetailed(m).text;
      if (!text) continue;
      const at = Date.parse(m.time);
      const inRange = at >= selected.from && at <= selected.to;
      items.push({
        kind: "user", time: m.time, text, message: i,
        sampleId: inRange && states[i].newTurn ? sampleIdFor(agent, path, m.id) : undefined,
      });
    } else if (m.Role === "assistant") {
      const text = assistantSaid(m);
      if (text) items.push({ kind: "assistant", time: m.time, text });
    }
  }
  for (const event of bashEvents(t)) {
    items.push({
      kind: "bash", time: event.time, command: event.command,
      output: clip(event.output, 12_000), name: event.name,
    });
  }
  const order = { user: 0, assistant: 1, bash: 2 } as const;
  items.sort((a, b) => a.time.localeCompare(b.time) || order[a.kind] - order[b.kind]);
  const first = firstUser(t);
  const focus = options.sample ? items.findIndex(item => item.sampleId === options.sample) : -1;
  const children = await subagentsOf(path, home);
  const subagents = (await mapLimit(children, 8, async sub => {
    try {
      const child = await readTranscript(sub.path, sub.agent);
      if (isHelperCall(child)) return null;
      const childStates = turnStates(child.messages);
      let turns = 0;
      for (let i = 0; i < child.messages.length; i++) {
        if (child.messages[i].Role === "user" && userSaidDetailed(child.messages[i]).text && childStates[i].newTurn) turns++;
      }
      return {
        id: sessionId(sub.path), subagentId: sub.subagentId ?? sub.key, agent: sub.agent,
        first: cutMiddle(firstUser(child), 240, 0),
        start: child.start ? new Date(child.start).toISOString() : "",
        end: child.end ? new Date(child.end).toISOString() : "",
        turnCount: turns,
      };
    } catch { return null; }
  })).filter((item): item is PreviewSubagent => !!item);
  return {
    id, agent, folder: t.cwd,
    start: t.start ? new Date(t.start).toISOString() : "",
    end: t.end ? new Date(t.end).toISOString() : "",
    first,
    turnCount: items.filter(item => item.sampleId).length,
    items, focus, subagents,
  };
}
