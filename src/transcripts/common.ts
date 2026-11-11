import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Message, Part } from "../textprep";

export type Agent = "claude" | "codex" | "pi";
export interface TimedMessage extends Message {
  id: string; time: string; cwd: string;
}
export interface Transcript {
  agent: Agent; path: string; session: string; aliases: string[]; cwd: string;
  start: number; end: number; messages: TimedMessage[]; malformed: number;
  // A subagent transcript is its own conversation, but belongs to a parent
  // session's directory entry.
  subagentId?: string;
  parentPath?: string;
  parentKey?: string;
}
export async function filesUnder(dir: string, suffixes: string[] = [".jsonl"]): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (err: any) { if (err.code === "ENOENT") return []; throw err; }
  const paths = await Promise.all(entries.map(e => e.isDirectory()
    ? filesUnder(join(dir, e.name), suffixes)
    : Promise.resolve(e.isFile() && suffixes.some(s => e.name.endsWith(s)) ? [join(dir, e.name)] : [])));
  return paths.flat().sort();
}
export async function* jsonLines(file: string): AsyncGenerator<{ row?: any; malformed?: boolean }> {
  // Codex compresses old rollouts with zstd. Bun ships the codec, so this
  // needs no external binary; a corrupt archive counts as one bad row.
  if (file.endsWith(".zst")) {
    let text: string;
    try { text = new TextDecoder().decode(Bun.zstdDecompressSync(await readFile(file))); }
    catch { yield { malformed: true }; return; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { yield { row: JSON.parse(line) }; } catch { yield { malformed: true }; }
    }
    return;
  }
  // Reading the whole file and splitting is much faster than a readline
  // iterator for the hundreds of small transcripts a full search touches.
  const text = await Bun.file(file).text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield { row: JSON.parse(line) }; } catch { yield { malformed: true }; }
  }
}
export function timestamp(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.flatMap(b => {
      if (typeof b === "string") return [b];
      if (!b || typeof b !== "object") return [];
      if (typeof b.text === "string") return [b.text];
      if (typeof b.content === "string") return [b.content];
      return [];
    }).join("\n");
  }
  if (content && typeof content === "object") {
    const value = content as any;
    if (typeof value.text === "string") return value.text;
    if (typeof value.output === "string") return value.output;
  }
  return "";
}
export function parts(content: unknown): Part[] {
  if (typeof content === "string") return [{ Kind: "text", Text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap(b => {
    if (!b || typeof b !== "object") return [];
    if (["text", "input_text", "output_text"].includes(b.type) && typeof b.text === "string") return [{ Kind: "text", Text: b.text }];
    if (["image", "input_image", "image_url"].includes(b.type)) return [{ Kind: "image" }];
    if (["file", "document", "input_file"].includes(b.type)) return [{ Kind: "file" }];
    if (["tool_use", "toolCall", "function_call"].includes(b.type)) {
      return [{ Kind: "tool_call", Call: { id: b.id ?? b.call_id, name: b.name, input: b.input ?? b.arguments } }];
    }
    if (["tool_result", "toolResult", "function_call_output"].includes(b.type)) {
      return [{ Kind: "tool_result", Call: { id: b.tool_use_id ?? b.toolCallId ?? b.call_id, name: b.name ?? b.toolName, output: textOf(b.content ?? b.output) } }];
    }
    return [{ Kind: "thinking" }];
  });
}
export function finish(t: Transcript): Transcript {
  t.messages.sort((a, b) => a.time.localeCompare(b.time));
  const first = t.messages[0], last = t.messages.at(-1);
  if (first) t.start = Math.min(t.start || Infinity, Date.parse(first.time));
  if (last) t.end = Math.max(t.end || 0, Date.parse(last.time));
  t.aliases = [...new Set([t.session, ...t.aliases].filter(Boolean))];
  return t;
}
export function emptyTranscript(agent: Agent, path: string): Transcript {
  return { agent, path, session: "", aliases: [], cwd: "", start: 0, end: 0, messages: [], malformed: 0 };
}
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); }
  }));
  return out;
}
