import type { Transcript } from "./common";

export interface BashEvent {
  id?: string;
  name: string;
  time: string;
  command: string;
  output: string;
}

const bashNames = new Set(["bash", "bash_background", "shell", "local_shell", "exec", "exec_command", "container.exec"]);
export function isBashName(name: string | undefined): boolean {
  return !!name && bashNames.has(name.toLowerCase());
}

function stringField(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const row = value as Record<string, unknown>;
  for (const key of keys) {
    const field = row[key];
    if (typeof field === "string") return field;
    if (Array.isArray(field) && field.every(v => typeof v === "string")) return field.join(" ");
  }
  return "";
}

function unquote(value: string): string {
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { /* fall through */ }
  }
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith("`") && value.endsWith("`"))) {
    return value.slice(1, -1).replace(/\\(["'`\\])/g, "$1");
  }
  return value;
}

// Codex's exec tool is a JavaScript wrapper around nested tools. The command
// is a string inside tools.exec_command({...}); pull it out for searching.
function nestedCommands(source: string): string[] {
  const out: string[] = [];
  const calls = /tools\.(?:exec_command|shell|local_shell|exec)\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  for (const call of source.matchAll(calls)) {
    const body = call[1];
    const field = /\b(?:cmd|command)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/.exec(body);
    if (field) out.push(unquote(field[1]));
  }
  return out;
}

function commandFromInput(name: string, input: unknown): string {
  if (typeof input === "string") {
    if (name.toLowerCase() === "exec") return nestedCommands(input).join("\n");
    try { input = JSON.parse(input); } catch { return input; }
  }
  const direct = stringField(input, ["command", "cmd", "script"]);
  if (direct) return direct;
  if (name.toLowerCase() === "exec" && input && typeof input === "object") {
    return nestedCommands(String((input as any).code ?? (input as any).input ?? ""));
  }
  return "";
}

const cached = new WeakMap<Transcript, BashEvent[]>();
export function bashEvents(t: Transcript): BashEvent[] {
  const old = cached.get(t);
  if (old) return old;
  const pending = new Map<string, BashEvent>();
  const events: BashEvent[] = [];
  for (const message of t.messages) {
    for (const part of message.Parts) {
      if (part.Kind !== "tool_call" && part.Kind !== "tool_result") continue;
      const call = part.Call;
      if (!call) continue;
      const id = call.id;
      if (part.Kind === "tool_call") {
        const name = call.name ?? "";
        if (!isBashName(name)) continue;
        const command = commandFromInput(name, call.input);
        if (!command) continue;
        const event: BashEvent = { id, name, time: message.time, command, output: "" };
        if (id) pending.set(id, event);
        events.push(event);
      } else {
        const output = call.output ?? "";
        const event = id ? pending.get(id) : undefined;
        if (event) event.output = output;
        else if (output) events.push({ id, name: call.name ?? "bash", time: message.time, command: "", output });
      }
    }
  }
  cached.set(t, events);
  return events;
}
