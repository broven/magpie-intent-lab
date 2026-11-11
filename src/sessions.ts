import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { assistantSaid, cutMiddle, trimSpace, userSaidDetailed } from "./textprep";
import { readHistory, readTranscript, sessionId, sessionPath, type Filters, type Sample } from "./history";
import { bashEvents, type BashEvent } from "./transcripts/bash";
import type { Agent, Transcript } from "./transcripts/common";

export type SearchScope = "first" | "user" | "reply" | "bash";
export const searchScopes: SearchScope[] = ["first", "user", "reply", "bash"];

export interface SearchSnippet {
  scope: SearchScope;
  text: string;
  start: number;
  end: number;
  lead: boolean;
  trail: boolean;
}
export interface SessionSummary {
  id: string;
  agent: Agent;
  folder: string;
  start: string;
  end: string;
  first: string;
  hits: number;
  snippets: SearchSnippet[];
  turns: number;
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
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A search and its follow-up scopes usually arrive together. Keep the
// linked-session result briefly so the second query does not reread routing
// and every transcript; transcript parsing itself stays mtime-cached.
const historyCache = new Map<string, { at: number; value: ReturnType<typeof readHistory> }>();
const HISTORY_TTL = 30_000;
async function historyFor(filters: Filters, home: string) {
  const key = JSON.stringify([filters.agents ?? "", filters.from ?? "", filters.to ?? "", home]);
  const old = historyCache.get(key);
  if (old && Date.now() - old.at < HISTORY_TTL) return old.value;
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
function snippet(text: string, hit: { start: number; end: number }, scope: SearchScope): SearchSnippet {
  const start = Math.max(0, hit.start - 90), end = Math.min(text.length, hit.end + 90);
  return {
    scope,
    text: text.slice(start, end),
    start: hit.start - start,
    end: hit.end - start,
    lead: start > 0,
    trail: end < text.length,
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
  if (!q) return { sessions: [], durationMs: Math.round(performance.now() - started) };
  const scopes = scopesOf(query.scopes);
  let re: RegExp;
  try { re = matcher(q, !!query.regex); } catch (err: any) { throw new Error(`正则无效: ${err?.message ?? err}`); }
  const limit = query.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit 必须是 1…1000 的整数");
  const filters: Filters = { agents: query.agents, from: query.from, to: query.to, limit: 10_000, all: true };
  const history = await historyFor(filters, home);
  const bySession = new Map<string, Sample[]>();
  for (const sample of history.samples) {
    const list = bySession.get(sample.session);
    if (list) list.push(sample); else bySession.set(sample.session, [sample]);
  }
  const sessions: SessionSummary[] = [];
  for (const [path, samples] of bySession) {
    const agent = samples[0].agent;
    const t = await readTranscript(path, agent);
    let hits = 0;
    const snippets: SearchSnippet[] = [];
    for (const item of searchTexts(t, scopes)) {
      const found = matches(item.text, re);
      hits += found.length;
      for (const hit of found) {
        if (snippets.length < 3) snippets.push(snippet(item.text, hit, item.scope));
      }
    }
    if (!hits) continue;
    const first = firstUser(t);
    sessions.push({
      id: sessionId(path), agent, folder: t.cwd || samples[0].folder,
      start: t.start ? new Date(t.start).toISOString() : samples[0].time,
      end: t.end ? new Date(t.end).toISOString() : samples[0].time,
      first: cutMiddle(first, 240, 0),
      hits, snippets, turns: samples.length,
    });
  }
  sessions.sort((a, b) => b.hits - a.hits || b.start.localeCompare(a.start));
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
        sampleId: inRange ? sampleIdFor(agent, path, m.id) : undefined,
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
  return {
    id, agent, folder: t.cwd,
    start: t.start ? new Date(t.start).toISOString() : "",
    end: t.end ? new Date(t.end).toISOString() : "",
    first,
    turnCount: items.filter(item => item.sampleId).length,
    items, focus,
  };
}
