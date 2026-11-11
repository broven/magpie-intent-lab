import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { filesUnder, type Agent } from "./transcripts/common";

// One entry per transcript file, with its place in a session tree. A main
// session is its own root; a subagent points at the parent transcript.
export interface SessionFile {
  path: string;
  agent: Agent;
  key: string;
  parentPath?: string;
  subagentId?: string;
  parentKey?: string;
  mtime?: string;
}

const TTL = 60_000;
const cache = new Map<string, { at: number; value: Promise<SessionFile[]> }>();

export function sessionFiles(home = homedir()): Promise<SessionFile[]> {
  const old = cache.get(home);
  if (old && Date.now() - old.at < TTL) {
    old.at = Date.now();
    return old.value;
  }
  const value = build(home);
  cache.set(home, { at: Date.now(), value });
  value.catch(() => cache.delete(home));
  return value;
}

const uuid = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i;

async function firstLine(file: string): Promise<string> {
  if (file.endsWith(".zst")) {
    try {
      const text = new TextDecoder().decode(Bun.zstdDecompressSync(await readFile(file)));
      const end = text.indexOf("\n");
      return end < 0 ? text : text.slice(0, end);
    } catch { return ""; }
  }
  try {
    const text = await Bun.file(file).slice(0, 512_000).text();
    const end = text.indexOf("\n");
    return end < 0 ? text : text.slice(0, end);
  } catch { return ""; }
}

async function codexMeta(file: string): Promise<{ key: string; parentKey?: string } | null> {
  try {
    const row = JSON.parse(await firstLine(file));
    if (!row || row.type !== "session_meta") return null;
    const p = row.payload ?? {};
    const own = typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? p.session_id : "";
    if (!own) return null;
    // Current rollouts put the parent in parent_thread_id; older ones only in
    // source.subagent.thread_spawn. A user fork (thread_source "user") is a
    // main chat of its own, not a subagent.
    const spawn = typeof p.source === "object" && p.source ? p.source.subagent : undefined;
    const spawnedParent = typeof spawn === "object" && spawn ? spawn.thread_spawn?.parent_thread_id : undefined;
    const parent = [p.parent_thread_id, spawnedParent].find(v => typeof v === "string" && v && v !== own);
    return {
      key: own,
      parentKey: typeof parent === "string" ? parent : undefined,
    };
  } catch { return null; }
}

async function build(home: string): Promise<SessionFile[]> {
  const [claudeFiles, codexFiles, piFiles] = await Promise.all([
    filesUnder(join(home, ".claude/projects")),
    filesUnder(join(home, ".codex/sessions"), [".jsonl", ".jsonl.zst"]),
    filesUnder(join(home, ".pi/agent/sessions")),
  ]);
  const out: SessionFile[] = [];
  for (const file of claudeFiles) {
    const sub = /[/\\]subagents[/\\](?:workflows[/\\][^/\\]+[/\\])?agent-([^/\\]+)\.jsonl$/.exec(file);
    if (sub) {
      out.push({
        path: file, agent: "claude", key: sub[1], subagentId: sub[1],
        parentPath: file.slice(0, sub.index) + ".jsonl",
      });
    } else {
      out.push({ path: file, agent: "claude", key: basename(file, ".jsonl") });
    }
  }
  const codex: SessionFile[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= codexFiles.length) return;
      const file = codexFiles[i];
      const meta = await codexMeta(file);
      const alias = basename(file).match(uuid)?.[0] ?? basename(file).replace(/\.zst$/, "").replace(/\.jsonl$/, "");
      codex.push({
        path: file, agent: "codex", key: meta?.key ?? alias,
        parentKey: meta?.parentKey,
      });
    }
  }));
  // The parent's rollout file names its thread id; match the subagent's
  // parent_thread_id to it. Prefer a plain rollout over its archived copy.
  const codexByKey = new Map<string, SessionFile>();
  for (const entry of codex) {
    const old = codexByKey.get(entry.key);
    if (!old || (old.path.endsWith(".zst") && !entry.path.endsWith(".zst"))) codexByKey.set(entry.key, entry);
  }
  for (const entry of codex) {
    if (!entry.parentKey) continue;
    entry.parentPath = codexByKey.get(entry.parentKey)?.path;
  }
  out.push(...codex);
  for (const file of piFiles) {
    const sub = /[/\\]([^/\\]+)[/\\]run-[^/\\]+[/\\]session\.jsonl$/.exec(file);
    if (sub) {
      out.push({
        path: file, agent: "pi", key: sub[1], subagentId: sub[1],
        parentPath: dirname(dirname(dirname(file))) + ".jsonl",
      });
    } else {
      out.push({
        path: file, agent: "pi",
        key: basename(file).match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1] ?? basename(file, ".jsonl"),
      });
    }
  }
  // A subagent's newest turn can be its fallback clock when it has no routing
  // samples; the catalog uses it only for sorting and the date filter.
  await Promise.all(out.filter(entry => entry.parentPath).map(async entry => {
    try { entry.mtime = (await stat(entry.path)).mtime.toISOString(); } catch { /* vanished */ }
  }));
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// Every transcript under a parent, including nested subagents.
export async function subagentsOf(parentPath: string, home = homedir()): Promise<SessionFile[]> {
  const files = await sessionFiles(home);
  const byPath = new Map(files.map(file => [file.path, file]));
  const out: SessionFile[] = [];
  for (const file of files) {
    let parent = file.parentPath;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (parent === parentPath) { out.push(file); break; }
      parent = byPath.get(parent)?.parentPath;
    }
  }
  return out;
}
