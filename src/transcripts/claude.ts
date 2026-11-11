import { basename } from "node:path";
import { emptyTranscript, finish, jsonLines, parts, timestamp } from "./common";

export async function readClaude(file: string) {
  const t = emptyTranscript("claude", file);
  const seen = new Set<string>();
  t.session = basename(file, ".jsonl");
  for await (const { row, malformed } of jsonLines(file)) {
    if (malformed) { t.malformed++; continue; }
    // api-request-blob is a snapshot of messages already recorded, never a turn.
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (!row.message || !["user", "assistant"].includes(row.message.role)) continue;
    const time = timestamp(row.timestamp);
    if (!time) continue;
    const id = String(row.uuid ?? `${time}:${t.messages.length}`);
    if (seen.has(id)) continue;
    seen.add(id);
    if (typeof row.sessionId === "string") t.aliases.push(row.sessionId);
    const cwd = typeof row.cwd === "string" ? row.cwd : t.cwd;
    if (cwd) t.cwd = cwd;
    const messageParts = parts(row.message.content);
    // Claude can stream assistant blocks into separate ledger entries. A block
    // with the same message ID belongs to the same assistant message.
    const previous = t.messages.at(-1);
    if (row.message.role === "assistant" && row.message.id && previous?.id === row.message.id && previous.Role === "assistant") {
      previous.Parts.push(...messageParts);
    } else {
      t.messages.push({ id: row.message.role === "assistant" ? row.message.id ?? id : id, time, cwd, Role: row.message.role, Parts: messageParts });
    }
  }
  return finish(t);
}
