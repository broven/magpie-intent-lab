import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { cutMiddle, trimSpace, userSaid } from "./textprep";
import { folderKey, type RuleRequest } from "./rules";
import { readClaude } from "./transcripts/claude";
import { readCodex } from "./transcripts/codex";
import { readPi } from "./transcripts/pi";
import { filesUnder, mapLimit, type Agent, type Transcript } from "./transcripts/common";

const agentNames: Agent[] = ["claude", "codex", "pi"];
export interface Sample {
  id: string; agent: Agent; session: string; folder: string; time: string;
  text: string; fullText: string; prev: { user: string; reply: string };
  features: RuleRequest; transcript: string; message: number; routing?: { id: number; time: string; group?: string };
}
export interface Filters { agents?: string | string[]; from?: string; to?: string; limit?: number }
interface Route {
  id: number; agent: Agent; session?: string; folder?: string; time: string;
  sub?: string; subagentId?: string; kind?: string; group?: { id?: string };
  rule?: { tokens?: number; images?: boolean; compact?: boolean; effort?: string; folder?: string };
}
interface AgentStats {
  routingRecords: number; linkedRecords: number; transcripts: number; hitRate: number; turns: number; ambiguous: number; unmatchedTurns: number;
}
export interface HistoryStats {
  routingRecords: number; linkedRecords: number; transcripts: number; turns: number;
  malformedRouting: number; malformedTranscript: number; agents: Record<Agent, AgentStats>;
}
export interface HistoryResult { samples: Sample[]; stats: HistoryStats }
const parsed = new Map<string, { stamp: string; value: Promise<Transcript> }>();
async function transcript(file: string, agent: Agent): Promise<Transcript> {
  const info = await stat(file), stamp = `${info.size}:${info.mtimeMs}`;
  const old = parsed.get(file);
  if (old?.stamp === stamp) return old.value;
  const value = agent === "claude" ? readClaude(file) : agent === "codex" ? readCodex(file) : readPi(file);
  parsed.set(file, { stamp, value });
  try { return await value; } catch (err) { parsed.delete(file); throw err; }
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
function emptyStats(): HistoryStats {
  const agents = Object.fromEntries(agentNames.map(a => [a, { routingRecords: 0, linkedRecords: 0, transcripts: 0, hitRate: 0, turns: 0, ambiguous: 0, unmatchedTurns: 0 }])) as Record<Agent, AgentStats>;
  return { routingRecords: 0, linkedRecords: 0, transcripts: 0, turns: 0, malformedRouting: 0, malformedTranscript: 0, agents };
}
export async function readHistory(filters: Filters = {}, home = homedir()): Promise<HistoryResult> {
  const selected = range(filters), stats = emptyStats();
  const routing = await readRouting(join(home, ".config/magpie/routing"));
  stats.malformedRouting = routing.malformed;
  const routes = routing.routes.filter(r => selected.agents.has(r.agent) && Date.parse(r.time) >= selected.from && Date.parse(r.time) <= selected.to);
  const files = await Promise.all([
    selected.agents.has("claude") ? filesUnder(join(home, ".claude/projects")) : [],
    selected.agents.has("codex") ? filesUnder(join(home, ".codex/sessions")) : [],
    selected.agents.has("pi") ? filesUnder(join(home, ".pi/agent/sessions")) : [],
  ]);
  const claudeFiles = new Map<string, string[]>();
  for (const file of files[0]) {
    const key = basename(file, ".jsonl");
    claudeFiles.set(key, [...(claudeFiles.get(key) ?? []), file]);
  }
  const codexFiles = new Map<string, string[]>();
  for (const file of files[1]) for (const key of basename(file).match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi) ?? []) {
    codexFiles.set(key, [...(codexFiles.get(key) ?? []), file]);
  }
  const pi = await mapLimit(files[2], 6, f => transcript(f, "pi"));
  const linked = new Map<string, { t: Transcript; routes: Route[] }>();
  await mapLimit(routes, 6, async route => {
    const s = stats.agents[route.agent]; s.routingRecords++; stats.routingRecords++;
    let candidates: Transcript[];
    if (route.agent === "pi") {
      const at = Date.parse(route.time);
      // A routing request starts between the user's message and its assistant reply.
      candidates = pi.filter(t => t.start <= at && at <= t.end && sameFolder(route, t));
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
    s.linkedRecords++; stats.linkedRecords++;
    const old = linked.get(t.path);
    if (old) old.routes.push(route); else linked.set(t.path, { t, routes: [route] });
  });
  const all: Sample[] = [];
  for (const { t, routes: attached } of linked.values()) {
    const s = stats.agents[t.agent]; s.transcripts++; stats.transcripts++; stats.malformedTranscript += t.malformed;
    attached.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const turns: { sample: Sample; at: number }[] = [];
    let previousUser = "", reply = "", lastAssistant = "";
    for (let i = 0; i < t.messages.length; i++) {
      const m = t.messages[i];
      if (m.Role === "assistant") {
        const text = m.Parts.filter(p => p.Kind === "text").map(p => trimSpace(p.Text ?? "")).filter(Boolean).join("\n");
        if (text) lastAssistant = text;
        continue;
      }
      if (m.Role !== "user") continue;
      const text = userSaid(m);
      if (!text) continue;
      reply = lastAssistant;
      const runes = Array.from(reply);
      const sample: Sample = {
        id: createHash("sha256").update(t.agent + "\0" + t.path + "\0" + m.id).digest("hex").slice(0, 24),
        agent: t.agent, session: t.path, folder: m.cwd || t.cwd, time: m.time,
        text: cutMiddle(text, 3000, 1000), fullText: text,
        prev: { user: cutMiddle(previousUser, 750, 250), reply: runes.length > 1000 ? "…" + runes.slice(-1000).join("") : reply },
        features: { agent: t.agent, folder: m.cwd || t.cwd, time: m.time, message: text },
        transcript: t.path, message: i,
      };
      turns.push({ sample, at: Date.parse(m.time) });
      previousUser = text; lastAssistant = "";
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
  for (const s of Object.values(stats.agents)) s.hitRate = s.routingRecords ? s.linkedRecords / s.routingRecords : 0;
  all.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  return { samples: all.slice(-selected.limit), stats };
}
