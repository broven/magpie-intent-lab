// Ported from gateway/prompt.go:712-786 and classify.go:264-335.
export interface Part { Kind: string; Text?: string }
export interface Message { Role: string; Parts: Part[] }
export interface Before { Intent?: string; Effort?: string; User?: string; Reply?: string }

// Go strings.TrimSpace uses Unicode White_Space (JS trim treats BOM differently).
export const trimSpace = (s: string): string => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
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
export function userWords(text: string): string {
  let t = text;
  if (t.includes("<system-reminder")) t = t.replace(reminders, "");
  t = trimSpace(t);
  if (t.includes("## My request")) {
    const at = [...t.matchAll(myRequest)].at(-1);
    if (at) t = trimSpace(t.slice(at.index! + at[0].length));
  }
  if (!t || agentsFor.test(t) || injected.some(lead => t.startsWith(lead))) return "";
  return t;
}
export function userSaid(m: Message): string {
  return m.Parts.filter(p => p.Kind === "text").map(p => userWords(p.Text ?? "")).filter(Boolean).join("\n");
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
export function cutMiddle(text: string, head: number, tail: number): string {
  const runes = Array.from(text);
  return runes.length > head + tail ? runes.slice(0, head).join("") + "\n…\n" + runes.slice(runes.length - tail).join("") : text;
}
export function userText(messages: Message[]): string {
  return cutMiddle(lastSaid(messages).text, 3000, 1000);
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
  if (runes.length > 1000) reply = "…" + runes.slice(-1000).join("");
  return { user: cutMiddle(user, 750, 250), reply };
}
