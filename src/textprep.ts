// Ported from gateway/prompt.go:712-786 and classify.go:264-335.
export interface ToolCall { id?: string; name?: string; input?: unknown; output?: string }
export interface Part { Kind: string; Text?: string; Call?: ToolCall }
export interface Message { Role: string; Parts: Part[] }
export interface Before { Intent?: string; Effort?: string; User?: string; Reply?: string }

// Go strings.TrimSpace uses Unicode White_Space (JS trim treats BOM differently).
export const trimSpace = (s: string): string => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
export const reminderTag = "<system-reminder";
export const myRequestMarker = "## My request:";
// The cuts are shared with the decision-logic panel, so the interface never
// keeps a second copy of these numbers.
export const textCut = { head: 3000, tail: 1000, marker: "\n…\n" };
export const prevCut = { userHead: 750, userTail: 250, replyTail: 1000, replyPrefix: "…" };
const reminders = /<system-reminder(?:[\t\n\f\r ][^>]*)?>.*?<\/system-reminder>/gs;
const myRequest = /^## My request(?: for Codex)?:[ \t]*\n?/gm;
const agentsFor = /^# (\S+\.md) instructions for (\S.*?)[ \t]*\n/;
export const injected = [
  "<system-reminder", "<environment_context>", "<user_instructions>", "<turn_aborted>",
  "<user_shell_command>", "<subagent_notification>", "<in-app-browser-context",
  "<external_codex_apps_open_page>", "<session-context",
  "<task-notification>", "<subagent-notification>", "<plugin_reference>",
  "Available agent types for the Agent tool:", "Available agent types and the tools they have access to:",
  "New agent types are now available for the Agent tool:",
  "The TodoWrite tool hasn't been used recently.", "The task tools haven't been used recently.",
  "Conversation rewind applied.", "Workspace rewind applied.",
  "The following deferred tools are", "# MCP Server Instructions", "The following MCP servers",
];
export interface WordsDetail {
  text: string;
  originalChars: number;
  reminders: number;
  beforeRequestChars: number;
  wholeInjection: boolean;
}
export function userWordsDetailed(text: string): WordsDetail {
  const remindersCount = [...text.matchAll(reminders)].length;
  let t = text;
  if (t.includes(reminderTag)) t = t.replace(reminders, "");
  t = trimSpace(t);
  let beforeRequestChars = 0;
  if (t.includes("## My request")) {
    const at = [...t.matchAll(myRequest)].at(-1);
    if (at) {
      beforeRequestChars = Array.from(t.slice(0, at.index!)).length;
      t = trimSpace(t.slice(at.index! + at[0].length));
    }
  }
  const originalChars = Array.from(text).length;
  if (!t || agentsFor.test(t) || injected.some(lead => t.startsWith(lead))) {
    return { text: "", originalChars, reminders: remindersCount, beforeRequestChars, wholeInjection: trimSpace(text) !== "" };
  }
  return { text: t, originalChars, reminders: remindersCount, beforeRequestChars, wholeInjection: false };
}
export function userWords(text: string): string {
  return userWordsDetailed(text).text;
}
export function userSaidDetailed(m: Message): WordsDetail {
  const all = m.Parts.filter(p => p.Kind === "text").map(p => userWordsDetailed(p.Text ?? ""));
  const parts = all.filter(p => p.text);
  return {
    text: parts.map(p => p.text).join("\n"),
    originalChars: all.reduce((n, p) => n + p.originalChars, 0),
    reminders: all.reduce((n, p) => n + p.reminders, 0),
    beforeRequestChars: all.reduce((n, p) => n + p.beforeRequestChars, 0),
    wholeInjection: all.length > 0 && all.every(p => p.wholeInjection),
  };
}
export function userSaid(m: Message): string {
  return userSaidDetailed(m).text;
}
export function assistantSaid(m: Message): string {
  return m.Parts.filter(p => p.Kind === "text").map(p => trimSpace(p.Text ?? "")).filter(Boolean).join("\n");
}
export function lastSaid(messages: Message[], end = messages.length): { index: number; text: string } {
  for (let i = Math.min(end, messages.length) - 1; i >= 0; i--) {
    if (messages[i].Role === "user") {
      const text = userSaid(messages[i]);
      if (text) return { index: i, text };
    }
  }
  return { index: -1, text: "" };
}
export function cutMiddle(text: string, head: number, tail: number, marker = textCut.marker): string {
  const runes = Array.from(text);
  return runes.length > head + tail ? runes.slice(0, head).join("") + marker + runes.slice(runes.length - tail).join("") : text;
}
export function userText(messages: Message[]): string {
  return cutMiddle(lastSaid(messages).text, textCut.head, textCut.tail);
}
export function turnBefore(messages: Message[]): { user: string; reply: string } {
  const { index: at } = lastSaid(messages);
  if (at < 0) return { user: "", reply: "" };
  const { index: from, text: user } = lastSaid(messages, at);
  let reply = "";
  for (let i = at - 1; i > from && !reply; i--) {
    if (messages[i].Role === "assistant") reply = assistantSaid(messages[i]);
  }
  const runes = Array.from(reply);
  if (runes.length > prevCut.replyTail) reply = prevCut.replyPrefix + runes.slice(-prevCut.replyTail).join("");
  return { user: cutMiddle(user, prevCut.userHead, prevCut.userTail), reply };
}
