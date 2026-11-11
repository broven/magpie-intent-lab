// Measure the first catalog request of a brand-new process. The server is
// started with INTENT_LAB_WARM=0, so the request pays the whole read itself.
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionPath } from "../src/history";
import { sessionFiles } from "../src/sessiontree";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = Bun.spawn([process.execPath, join(root, "src/server.ts")], {
  cwd: root,
  env: { ...process.env, INTENT_LAB_PORT: "0", INTENT_LAB_WARM: "0" },
  stdout: "pipe",
  stderr: "inherit",
});
let base = "";
const stdout = (async () => {
  const reader = child.stdout.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const hit = /^intent-lab listening (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (hit) base = hit[1]; else if (line) console.log(line);
    }
  }
})();

// The first user message of a subagent, read line by line instead of through
// the transcript parser, so the cold search below still pays that parse.
async function firstUserText(file: string): Promise<string> {
  const text = await Bun.file(file).text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type !== "user") continue;
      const content = row?.message?.content;
      const said = typeof content === "string"
        ? content
        : Array.isArray(content) ? content.map((part: any) => part?.text ?? "").join("\n") : "";
      if (said.trim()) return said;
    } catch { /* not a row */ }
  }
  return "";
}

try {
  const deadline = Date.now() + 15_000;
  while (!base && Date.now() < deadline && child.exitCode === null) await Bun.sleep(50);
  if (!base) throw new Error("service did not announce a loopback port");
  const html = await (await fetch(base + "/")).text();
  const token = /name="intent-lab-token" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(token, "the page must carry this process's token");
  const headers = { "x-intent-lab-token": token };
  const get = async (path: string) => {
    const started = performance.now();
    const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(900_000) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
    return { ms: Math.round(performance.now() - started), data: await response.json() as any };
  };

  const catalog = await get("/api/sessions?limit=30");
  console.log(`cold catalog GET /api/sessions?limit=30: ${catalog.ms}ms, ${catalog.data.sessions.length} sessions`);
  assert.ok(catalog.ms < 20_000, `cold catalog must finish under 20s, took ${catalog.ms}ms`);

  const parents = catalog.data.sessions.filter((session: any) => session.subagents > 0);
  assert.ok(parents.length, "the catalog must contain a session with subagents");
  const index = await sessionFiles();
  let parent: any = null, word = "";
  for (const candidate of parents) {
    const parentPath = sessionPath(candidate.id);
    const parentText = await Bun.file(parentPath).text();
    const children = index.filter(file => file.parentPath === parentPath);
    for (const sub of children) {
      const said = await firstUserText(sub.path);
      const tokens = said.match(/[A-Za-z][A-Za-z0-9_-]{11,}/g) ?? [];
      word = tokens.find((token: string) => !parentText.includes(token)) ?? "";
      if (word) { parent = candidate; break; }
    }
    if (word) break;
  }
  assert.ok(parent && word, "a word present only in a subagent's first message must exist");
  const search = await get(`/api/sessions?q=${encodeURIComponent(word)}&scopes=user&limit=30`);
  const found = search.data.sessions.find((session: any) => session.id === parent.id);
  console.log(`cold subagent search (scopes=user, q="${word}"): ${search.ms}ms, ${search.data.sessions.length} sessions, hits=${found?.hits ?? 0}`);
  assert.ok(found, "the subagent word must find its parent session");
  assert.ok(found.snippets.some((snippet: any) => !!snippet.subagent), "the hit must be marked as a subagent snippet");
} finally {
  child.kill();
  await child.exited;
  await stdout;
}
