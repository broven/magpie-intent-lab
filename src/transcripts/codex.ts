import { basename } from "node:path";
import { emptyTranscript, finish, jsonLines, parts, textOf, timestamp } from "./common";

export async function readCodex(file: string) {
  const t = emptyTranscript("codex", file);
  const seen = new Set<string>();
  t.aliases = basename(file).match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi) ?? [];
  for await (const { row, malformed } of jsonLines(file)) {
    if (malformed) { t.malformed++; continue; }
    const p = row.payload;
    if (!p || typeof p !== "object") continue;
    if (row.type === "session_meta") {
      t.session = String(p.session_id ?? p.id ?? t.aliases[0] ?? "");
      t.aliases.push(...[p.id, p.session_id].filter(v => typeof v === "string"));
      if (typeof p.cwd === "string") t.cwd = p.cwd;
      t.start = Date.parse(timestamp(p.timestamp ?? row.timestamp)) || 0;
    }
    if (row.type === "turn_context" && typeof p.cwd === "string") t.cwd = p.cwd;
    // event_msg/item_completed duplicate response_item messages in Codex logs.
    if (row.type !== "response_item") continue;
    if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
      const time = timestamp(row.timestamp);
      if (!time) continue;
      const id = String(p.id ?? `${row.ordinal ?? time}:${t.messages.length}`);
      if (p.id && seen.has(id)) continue;
      seen.add(id);
      t.messages.push({ id, time, cwd: t.cwd, Role: p.role, Parts: parts(p.content) });
      continue;
    }
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const time = timestamp(row.timestamp);
      if (!time) continue;
      const id = String(p.call_id ?? p.id ?? `${row.ordinal ?? time}:${t.messages.length}`);
      if (seen.has(id)) continue;
      seen.add(id);
      t.messages.push({
        id, time, cwd: t.cwd, Role: "tool",
        Parts: [{ Kind: "tool_call", Call: { id, name: p.name, input: p.arguments ?? p.input } }],
      });
      continue;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const time = timestamp(row.timestamp);
      if (!time) continue;
      const id = String(p.call_id ?? p.id ?? `${row.ordinal ?? time}:${t.messages.length}`);
      t.messages.push({
        id: id + ":result", time, cwd: t.cwd, Role: "tool",
        Parts: [{ Kind: "tool_result", Call: { id, name: p.name, output: textOf(p.output) } }],
      });
    }
  }
  return finish(t);
}
