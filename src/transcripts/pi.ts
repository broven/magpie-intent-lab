import { dirname } from "node:path";
import { emptyTranscript, finish, jsonLines, parts, textOf, timestamp } from "./common";

export async function readPi(file: string) {
  const t = emptyTranscript("pi", file);
  const seen = new Set<string>();
  // A pi subagent lives at <project>/<parent-stem>/<subagent-id>/run-N/session.jsonl.
  const sub = /[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\]run-[^/\\]+[/\\]session\.jsonl$/.exec(file);
  if (sub) {
    t.subagentId = sub[2];
    t.parentPath = dirname(dirname(dirname(file))) + ".jsonl";
  }
  for await (const { row, malformed } of jsonLines(file)) {
    if (malformed) { t.malformed++; continue; }
    if (row.type === "session") {
      t.session = typeof row.id === "string" ? row.id : "";
      t.cwd = typeof row.cwd === "string" ? row.cwd : "";
      t.start = Date.parse(timestamp(row.timestamp)) || 0;
    }
    if (row.type !== "message" || !row.message) continue;
    const time = timestamp(row.timestamp ?? row.message.timestamp);
    if (!time) continue;
    const id = String(row.id ?? `${time}:${t.messages.length}`);
    if (seen.has(id)) continue;
    seen.add(id);
    if (row.message.role === "toolResult") {
      t.messages.push({
        id, time, cwd: t.cwd, Role: "tool",
        Parts: [{ Kind: "tool_result", Call: { id: row.message.toolCallId, name: row.message.toolName, output: textOf(row.message.content) } }],
      });
      continue;
    }
    if (!["user", "assistant"].includes(row.message.role)) continue;
    t.messages.push({ id, time, cwd: t.cwd, Role: row.message.role, Parts: parts(row.message.content) });
  }
  return finish(t);
}
