import { emptyTranscript, finish, jsonLines, parts, timestamp } from "./common";

export async function readPi(file: string) {
  const t = emptyTranscript("pi", file);
  const seen = new Set<string>();
  for await (const { row, malformed } of jsonLines(file)) {
    if (malformed) { t.malformed++; continue; }
    if (row.type === "session") {
      t.session = typeof row.id === "string" ? row.id : "";
      t.cwd = typeof row.cwd === "string" ? row.cwd : "";
      t.start = Date.parse(timestamp(row.timestamp)) || 0;
    }
    if (row.type !== "message" || !row.message || !["user", "assistant"].includes(row.message.role)) continue;
    const time = timestamp(row.timestamp ?? row.message.timestamp);
    if (!time) continue;
    const id = String(row.id ?? `${time}:${t.messages.length}`);
    if (seen.has(id)) continue;
    seen.add(id);
    t.messages.push({ id, time, cwd: t.cwd, Role: row.message.role, Parts: parts(row.message.content) });
  }
  return finish(t);
}
