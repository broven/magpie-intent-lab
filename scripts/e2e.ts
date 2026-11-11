import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory, readTranscript, sessionPath } from "../src/history";
import { sessionFiles } from "../src/sessiontree";
import { turnIn, userSaid } from "../src/textprep";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactDir = join(root, "artifacts");
await mkdir(artifactDir, { recursive: true, mode: 0o700 });
const artifactPath = join(artifactDir, `e2e-${new Date().toISOString().replaceAll(":", "-")}.json`);
const configFile = join(homedir(), ".config/magpie/providers.json");
const digest = async () => createHash("sha256").update(await readFile(configFile)).digest("hex");
const configBefore = await digest();

// The real apply runs the real magpie CLI. XDG_CONFIG_HOME moves its
// providers.json into this sandbox; HOME keeps its agent-file migrations
// and catalog sync away from the user's ~/.claude, ~/.codex and so on.
const sandbox = await mkdtemp(join(tmpdir(), "intent-lab-apply-"));
const sandboxHome = join(sandbox, "home");
await mkdir(join(sandbox, "magpie"), { recursive: true, mode: 0o700 });
await mkdir(sandboxHome, { recursive: true, mode: 0o700 });
await copyFile(configFile, join(sandbox, "magpie/providers.json"));
// The plugin must read the same config the CLI writes. Seed the sandbox with
// a compact rule when the real group has none, so the write-back path always
// exercises a non-intent rule; the real config stays untouched.
const sandboxConfigFile = join(sandbox, "magpie/providers.json");
const sandboxConfig = JSON.parse(await readFile(sandboxConfigFile, "utf8"));
const seedGroup = (sandboxConfig.groups ?? []).find((g: any) => g?.id === "claude-opus");
let seededCompact: any = null;
if (seedGroup && !(seedGroup.rules ?? []).some((rule: any) => rule?.compact)) {
  const use = (seedGroup.members ?? [])[0];
  if (use) {
    seededCompact = { use, compact: true };
    seedGroup.rules = [seededCompact, ...(seedGroup.rules ?? [])];
    await writeFile(sandboxConfigFile, JSON.stringify(sandboxConfig, null, 2) + "\n");
  }
}
const cliEnv = { XDG_CONFIG_HOME: sandbox, HOME: sandboxHome };

const artifact: any = { started: new Date().toISOString(), checks: [], configBefore, sandbox: { xdg: sandbox, home: sandboxHome, seededCompact } };
const child = Bun.spawn([process.execPath, join(root, "src/server.ts")], {
  cwd: root,
  env: { ...process.env, INTENT_LAB_PORT: "0", INTENT_LAB_MAGPIE_ENV: JSON.stringify(cliEnv), XDG_CONFIG_HOME: sandbox },
  stdout: "pipe",
  stderr: "inherit",
});
let base = "";
let token = "";
const auth = () => ({ "x-intent-lab-token": token });
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
function check(label: string, detail: unknown) {
  artifact.checks.push({ label, status: "PASS", detail });
  console.log(`PASS ${label}`);
}
async function json(path: string, body?: unknown) {
  // The first samples request shares the start-up read of every routed
  // transcript. A large home can take minutes; Bun's default fetch timeout is
  // five, shorter than that cold read.
  const signal = AbortSignal.timeout(900_000);
  const response = await fetch(base + path, body === undefined ? { headers: auth(), signal } : {
    method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
async function runAt(urlBase: string, tokenValue: string, body: unknown) {
  const response = await fetch(urlBase + "/api/run", { method: "POST", headers: { "content-type": "application/json", "x-intent-lab-token": tokenValue }, body: JSON.stringify(body), signal: AbortSignal.timeout(900_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events: any[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "", result: any;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      const parsed = JSON.parse(data);
      events.push({ event, data: parsed });
      if (event === "error") throw Error(parsed.error);
      if (event === "result") result = parsed;
    }
  }
  assert.ok(events.some(e => e.event === "progress"), "SSE must report progress");
  assert.ok(result, "SSE must end with a result");
  return { result, events };
}
const run = (body: unknown) => runAt(base, token, body);

async function startLab(cacheDir: string) {
  const proc = Bun.spawn([process.execPath, join(root, "src/server.ts")], {
    cwd: root,
    env: {
      ...process.env, INTENT_LAB_PORT: "0",
      INTENT_LAB_MAGPIE_ENV: JSON.stringify(cliEnv),
      XDG_CONFIG_HOME: sandbox,
      INTENT_LAB_DIR: cacheDir,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  let url = "";
  const pump = (async () => {
    const reader = proc.stdout.getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const hit = /^intent-lab listening (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
        if (hit) url = hit[1]; else if (line) console.log(line);
      }
    }
  })();
  const deadline = Date.now() + 15_000;
  while (!url && Date.now() < deadline && proc.exitCode === null) await Bun.sleep(50);
  if (!url) throw new Error("fresh service did not announce a port");
  const pageHtml = await (await fetch(url + "/")).text();
  const pageToken = pageHtml.match(/name="intent-lab-token" content="([0-9a-f]{64})"/)?.[1] ?? "";
  if (!pageToken) throw new Error("fresh service page has no token");
  return {
    base: url,
    token: pageToken,
    run: (body: unknown) => runAt(url, pageToken, body),
    stop: async () => { proc.kill(); await proc.exited; await pump; },
  };
}
try {
  const deadline = Date.now() + 15_000;
  while (!base && Date.now() < deadline && child.exitCode === null) await Bun.sleep(50);
  assert.ok(base, "service must announce a random loopback port");
  artifact.base = base;
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Intent Lab/);
  token = pageHtml.match(/name="intent-lab-token" content="([0-9a-f]{64})"/)?.[1] ?? "";
  assert.ok(token, "served HTML must carry the API token");
  const { groups } = await json("/api/groups");
  const group = groups.find((g: any) => g.id === "claude-opus");
  assert.ok(group, "claude-opus must be present");
  assert.equal(group.supported, true, group.reason);
  artifact.group = group;
  assert.equal(await digest(), configBefore, "real config changed while the e2e was starting; rerun against a stable config");
  check("1 groups includes claude-opus", { classifier: group.classifier });
  const samples = await json("/api/samples?limit=30");
  assert.ok(samples.samples.length >= 1);
  assert.ok(samples.samples.length <= 30);
  for (let i = 1; i < samples.samples.length; i++) assert.ok(samples.samples[i - 1].time <= samples.samples[i].time);
  artifact.samples = samples;
  for (const agent of ["claude", "codex", "pi"]) {
    const s = samples.stats.agents[agent];
    assert.ok(s && s.routingRecords >= s.linkedRecords);
    console.log(`${agent} routing=${s.routingRecords} linked=${s.linkedRecords} transcripts=${s.transcripts} hitRate=${(100 * s.hitRate).toFixed(2)}% turns=${s.turns} ambiguous=${s.ambiguous}`);
  }
  check("2 real samples and association stats", { samples: samples.samples.length });

  // E-1: the catalog without q is the recent N sessions, by last turn desc.
  const firstPage = await json("/api/sessions?limit=10");
  artifact.catalog = firstPage;
  assert.equal(firstPage.sessions.length, 10, "the catalog must list exactly 10 sessions");
  for (const session of firstPage.sessions) {
    assert.ok(session.id && session.lastTurn && Number.isInteger(session.turns), "each catalog session needs id/lastTurn/turns");
    assert.ok(session.turns >= 1, "a listed session must have a turn");
  }
  for (let i = 1; i < firstPage.sessions.length; i++) {
    assert.ok(firstPage.sessions[i - 1].lastTurn >= firstPage.sessions[i].lastTurn, "catalog must be sorted by last turn desc");
  }
  check("E-1 catalog: 10 sessions sorted by last turn desc", {
    first: firstPage.sessions[0].lastTurn, last: firstPage.sessions.at(-1).lastTurn,
  });

  // F-1: one catalog entry per main session. Subagent transcripts and Orca's
  // title helper calls must not appear as chats of their own.
  const fCatalog = await json("/api/sessions?limit=30");
  artifact.catalogF = fCatalog;
  assert.ok(fCatalog.sessions.length > 0, "F-1 catalog must have entries");
  for (const session of fCatalog.sessions) {
    const path = sessionPath(session.id);
    assert.ok(!path.includes("/subagents/"), `catalog entry must not be a subagent transcript: ${path}`);
    assert.ok(!(session.turns === 1 && (session.first ?? "").trimStart().startsWith("Name this chat from the user's first request")), `catalog entry must not be a title helper call: ${path}`);
    assert.ok(Number.isInteger(session.subagents) && session.subagents >= 0, `catalog entry needs a subagent count: ${path}`);
  }
  const fParent = fCatalog.sessions.find((session: any) => sessionPath(session.id).includes("06d555c1-40da-4c28-a0a3-b1d15f76b8e7.jsonl"));
  assert.ok(fParent, "F-1 must list the current main session");
  assert.ok(fParent.subagents >= 1, `F-1 current session must report its subagents, got ${fParent.subagents}`);
  check("F-1 catalog: main sessions only, subagents counted, helpers excluded", {
    sessions: fCatalog.sessions.length, parentSubagents: fParent.subagents,
  });

  const catalog = await json("/api/sessions?limit=100");
  const multi = catalog.sessions.filter((session: any) => session.turns > 1).slice(0, 3);
  assert.equal(multi.length, 3, "the catalog must hold at least 3 multi-turn sessions");
  const single = catalog.sessions.find((session: any) => session.turns === 1);
  assert.ok(single, "the catalog must hold a single-turn session");
  artifact.catalogPicked = { multi: multi.map((session: any) => ({ id: session.id, turns: session.turns })), single: { id: single.id, turns: single.turns } };
  const draft = { rules: structuredClone(group.rules), intentSure: group.intentSure };
  const same = await run({ group: group.id, draft, sessions: multi.map((session: any) => session.id), k: 3, includeSubagents: false, stopAfterHit: false });
  artifact.identical = same;
  const sameRows = same.result.sessions.flatMap((session: any) => session.rows);
  assert.ok(sameRows.length >= 1);
  assert.ok(sameRows.every((r: any) => r.changed === false), "identical rules must produce identical rows");
  assert.equal(same.result.summary.changed, 0);
  check("3 identical draft changed=0", { sessions: same.result.sessions.length, rows: sameRows.length, cache: same.result.cache });

  // E-2: each selected session replays every turn, numbered from 1.
  assert.equal(same.result.sessions.length, 3, "E-2 must return the three selected sessions");
  for (const picked of multi) {
    const got = same.result.sessions.find((session: any) => session.id === picked.id);
    assert.ok(got, `session ${picked.id} must be in the result`);
    // A session an agent is still writing grows between the list and the
    // run: the run's own count is the truth, never fewer than the list's.
    assert.ok(got.turns >= picked.turns, `session ${picked.id} turn count ${got.turns} < listed ${picked.turns}`);
    assert.equal(got.rows.length, got.turns, `session ${picked.id} row count`);
    for (let i = 0; i < got.rows.length; i++) assert.equal(got.rows[i].turn, i + 1, `session ${picked.id} rounds must be 1..n`);
  }
  check("E-2 three multi-turn sessions: rows = turns, turns 1..n", {
    sessions: same.result.sessions.map((session: any) => ({ id: session.id, turns: session.turns, rows: session.rows.length })),
  });

  const edited = structuredClone(draft);
  for (const rule of edited.rules) if (rule.intent) rule.intent = "写代码或改代码";
  const changed = await run({ group: group.id, draft: edited, sessions: multi.map((session: any) => session.id), k: 3, includeSubagents: false, stopAfterHit: false });
  artifact.edited = changed;
  const changedRows = changed.result.sessions.flatMap((session: any) => session.rows);
  assert.ok(changedRows.some((r: any) => r.changed === true), "edited intent must change at least one row");
  assert.ok(changed.result.summary.changed > 0);
  check(`4 edited intent changed=${changed.result.summary.changed}`, { rows: changedRows.length, cache: changed.result.cache });
  const commands = await json("/api/apply", { group: group.id, baseline: group.rules, draft: edited, dryRun: true });
  artifact.apply = commands;
  assert.ok(Array.isArray(commands.commands) && commands.commands.length > 0);
  assert.ok(commands.commands.some((c: string) => /group rule rm/.test(c)));
  assert.ok(commands.commands.some((c: string) => /group rule add/.test(c) && c.includes("写代码或改代码") && c.includes("at=")));
  // Only the rule the draft changed may be touched. A non-intent rule (such
  // as compact) has to keep its use, its position and its CLI spelling.
  const changedRules = edited.rules
    .map((rule: any, index: number) => ({ rule, index }))
    .filter(({ rule, index }: any) => JSON.stringify(rule) !== JSON.stringify(group.rules[index]));
  assert.equal(changedRules.length, 1, "this draft must change exactly one rule");
  const changedAt = changedRules[0].index + 1;
  for (const command of commands.commands) {
    const rm = / group rule rm [^ ]+ (\d+)$/.exec(command);
    const add = / at=(\d+)$/.exec(command);
    const at = rm ? Number(rm[1]) : add ? Number(add[1]) : null;
    assert.equal(at, changedAt, `apply must touch only rule ${changedAt}: ${command}`);
  }
  assert.ok(!commands.commands.some((c: string) => /compact/.test(c)), "unchanged compact rule must not be rewritten");
  // A draft made from older rules must never delete rules that appeared since.
  const staleBaseline = group.rules.slice(0, Math.max(0, group.rules.length - 1));
  const staleResponse = await fetch(base + "/api/apply", {
    method: "POST", headers: { "content-type": "application/json", ...auth() },
    body: JSON.stringify({ group: group.id, baseline: staleBaseline, draft: edited, dryRun: true }),
  });
  assert.equal(staleResponse.status, 400, "a changed group must refuse the stale draft");
  const stale = await staleResponse.json() as any;
  assert.match(stale.error ?? "", /加载后变化/, "the refusal must name the changed group");
  assert.equal((stale.commands ?? []).length, 0, "the stale draft must not produce commands");
  check("5 apply dryRun commands", { commands: commands.commands.length, changedRule: changedAt, staleRefused: true });
  const real = await json("/api/apply", { group: group.id, baseline: group.rules, draft: edited, dryRun: false });
  artifact.applyReal = {
    ok: real.ok,
    commands: real.commands,
    executed: real.executed,
    rejected: real.rejected,
    readBack: real.readBack,
    error: real.error,
  };
  assert.equal(real.ok, true, real.error);
  assert.ok(Array.isArray(real.executed) && real.executed.length > 0, "real apply must execute commands");
  assert.match(real.readBack ?? "", /写代码或改代码/, "readback must contain the new intent");
  const sandboxConfig = JSON.parse(await readFile(join(sandbox, "magpie/providers.json"), "utf8"));
  const sandboxGroup = sandboxConfig.groups.find((g: any) => g.id === group.id);
  assert.ok(sandboxGroup, "the sandbox config must still hold the written group");
  // The read-back order must equal the draft byte for byte (in rule order),
  // including rules the draft never touched.
  assert.deepEqual(sandboxGroup.rules, edited.rules, "read-back rules must equal the draft and preserve order");
  const preserved = group.rules.filter((rule: any) => !rule.intent);
  assert.ok(preserved.length >= 1, "step 6 needs a group with a non-intent (e.g. compact) rule");
  for (const rule of preserved) {
    const at = group.rules.indexOf(rule);
    assert.deepEqual(sandboxGroup.rules[at], rule, `non-intent rule ${at + 1} must keep its use and position`);
  }
  const changedRule = sandboxGroup.rules[changedAt - 1];
  assert.equal(changedRule.intent, "写代码或改代码", `rule ${changedAt} must be the new intent`);
  assert.match(real.readBack ?? "", /compacting[\s\S]*写代码或改代码/, "readback must keep the compact rule before the new intent");
  artifact.configAfter = await digest();
  assert.equal(artifact.configAfter, configBefore, "real configuration must remain byte-for-byte unchanged");
  check("6 sandboxed real apply; non-intent rule preserved; order equals draft; real config unchanged", {
    executed: real.executed.length,
    rules: sandboxGroup.rules,
    readBack: real.readBack.split("\n").filter(Boolean).slice(0, 5),
  });
  const html = await (await fetch(base + "/")).text();
  const anchors = ["draft-editor", "run-button", "group-select", "session-list", "session-limit", "k-input", "stop-after-hit", "timing-filter", "session-results", "summary", "apply-preview", "apply-run"];
  for (const anchor of anchors) assert.ok(html.includes(`data-testid="${anchor}"`), `UI must contain data-testid=${anchor}`);
  check("7 UI anchors", { anchors });
  // 8: the frame's page and the service's guard. magpie's page policy runs
  // scripts from the plugin's folder only, so the page may hold no inline one.
  const framePage = await Bun.file(new URL("../page/index.html", import.meta.url)).text();
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(framePage), false, "page/index.html must have no inline <script>");
  assert.ok(await Bun.file(new URL("../page/boot.js", import.meta.url)).exists(), "page/boot.js must exist");
  const status = async (headers: Record<string, string>, path = "/api/groups", method = "GET") =>
    (await fetch(base + path, { method, headers })).status;
  assert.equal(await status({}), 403, "no token must be refused");
  assert.equal(await status({ ...auth(), origin: "https://evil.example" }), 403, "a foreign origin must be refused");
  assert.equal(await status({ ...auth(), host: "evil.example" }), 403, "a foreign host must be refused");
  const framed = await fetch(base + "/api/groups", { headers: { ...auth(), origin: "null" } });
  assert.equal(framed.status, 200, "the sandboxed frame (Origin null) with the token must be served");
  assert.equal(framed.headers.get("access-control-allow-origin"), "null");
  assert.equal(await status({ origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-intent-lab-token" }, "/api/run", "OPTIONS"), 204, "preflight must pass");
  const index = await fetch(base + "/", { headers: { origin: "null" } });
  assert.equal(index.headers.get("access-control-allow-origin"), null, "the HTML holding the token must carry no CORS header");
  check("8 frame page has no inline script; service guard", { refused: ["no token", "foreign origin", "foreign host"], allowed: "Origin null + token" });
  // 9: search a word from the first real sample's first message, then a real
  // bash command. The search only picks sessions; the run below replays all
  // turns of the picked sessions.
  // A word from a session's own first message: a sample is any turn, and
  // its words needn't be in its session's first message.
  const firstMessage = catalog.sessions.map((session: any) => session.first ?? "").find((text: string) => /[A-Za-z][A-Za-z0-9_-]{3,}/.test(text)) ?? "git";
  const word = (firstMessage.match(/[A-Za-z][A-Za-z0-9_-]{3,}/) ?? ["git"])[0];
  const firstSearch = await json(`/api/sessions?q=${encodeURIComponent(word)}&scopes=first&limit=100`);
  artifact.sessionSearch = { word, durationMs: firstSearch.durationMs, sessions: firstSearch.sessions.length };
  assert.ok(firstSearch.sessions.length >= 1, `first-message search for ${word} must find a session`);
  assert.ok(firstSearch.sessions.some((session: any) => session.snippets.some((snippet: any) => snippet.text.toLowerCase().includes(word.toLowerCase()))), "the first search snippet must contain the word");
  // The first search may still share the start-up warm-up's read (cold
  // parse of every transcript); it is reported, not held to the bound. What
  // the user meets once the plugin has been up a moment is the warm one.
  console.log(`search (first, may wait on warm-up) "${word}": ${firstSearch.durationMs}ms`);
  const warmSearch = await json(`/api/sessions?q=${encodeURIComponent(word)}&scopes=first,user,reply,bash&limit=100`);
  artifact.sessionSearch.warmAllScopesMs = warmSearch.durationMs;
  console.log(`search (warm, all scopes) "${word}": ${warmSearch.durationMs}ms`);
  assert.ok(warmSearch.durationMs < 5000, `warm full search must be under 5s, took ${warmSearch.durationMs}ms`);
  console.log(`search first "${word}": ${firstSearch.sessions.length} sessions in ${firstSearch.durationMs}ms`);
  const bashQuery = "git status";
  const bashSearch = await json(`/api/sessions?q=${encodeURIComponent(bashQuery)}&scopes=bash&limit=100`);
  artifact.bashSearch = { query: bashQuery, durationMs: bashSearch.durationMs, sessions: bashSearch.sessions.length };
  assert.ok(bashSearch.sessions.length >= 1, `bash search for ${bashQuery} must find a session`);
  assert.ok(bashSearch.sessions.some((session: any) => session.snippets.some((snippet: any) => snippet.scope === "bash" && snippet.text.toLowerCase().includes(bashQuery))), "the bash snippet must contain the command");
  assert.ok(bashSearch.durationMs < 5000, `full bash search must be under 5s, took ${bashSearch.durationMs}ms`);
  console.log(`search bash "${bashQuery}": ${bashSearch.sessions.length} sessions in ${bashSearch.durationMs}ms`);
  check("9 session search first-message and bash", { word, first: firstSearch.sessions.length, bash: bashSearch.sessions.length });

  // F-2: a word that appears only in a subagent's first message finds the
  // parent session, with the snippet marked as a subagent hit.
  const fParentPath = sessionPath(fParent.id);
  const fIndex = await sessionFiles();
  const fChildren = fIndex.filter(file => file.parentPath === fParentPath);
  assert.ok(fChildren.length >= 1, "F-2 needs the current session's subagent transcripts");
  const parentTranscript = await readTranscript(fParentPath, "claude");
  const parentText = parentTranscript.messages.map(m => m.Parts.map(p => p.Text ?? "").join("\n")).join("\n");
  let fWord = "", fChildPath = "";
  for (const child of fChildren) {
    const t = await readTranscript(child.path, child.agent);
    let first = "";
    for (const m of t.messages) if (m.Role === "user") { const said = userSaid(m); if (said) { first = said; break; } }
    const tokens = [
      ...(first.match(/[A-Za-z][A-Za-z0-9_-]{7,}/g) ?? []),
      ...(first.match(/[一-鿿]{6,}/g) ?? []),
    ];
    const word = tokens.find(token => !parentText.includes(token));
    if (word) { fWord = word; fChildPath = child.path; break; }
  }
  assert.ok(fWord, "F-2 must find a word present only in a subagent message");
  const fSearch = await json(`/api/sessions?q=${encodeURIComponent(fWord)}&scopes=user&limit=100`);
  artifact.searchF = { word: fWord, child: fChildPath, sessions: fSearch.sessions.length };
  const fFound = fSearch.sessions.find((session: any) => session.id === fParent.id);
  assert.ok(fFound, `F-2 search for the subagent-only word must return the parent session`);
  assert.ok(fFound.snippets.some((snippet: any) => !!snippet.subagent && snippet.text.toLowerCase().includes(fWord.toLowerCase())), "F-2 snippet must be marked as a subagent hit");
  check("F-2 subagent-only search returns the parent, snippet marked 子 agent", {
    word: fWord, child: fChildPath.split("/").slice(-1)[0], hits: fFound.hits,
  });
  // E-3: timing classes, first hit and the histogram, all from the draft side.
  const timingIds = [...multi.map((session: any) => session.id), single.id];
  const timingUse = (group.rules.find((rule: any) => rule.intent) ?? group.rules.find((rule: any) => rule.use))?.use;
  const timingOther = group.members.find((member: string) => member !== timingUse);
  assert.ok(timingUse && timingOther, "claude-opus must have at least two members for the timing switch");
  const baseRun = await run({ group: group.id, draft, sessions: timingIds, k: 3, includeSubagents: false, stopAfterHit: false });
  // A rule whose message condition appears only in a later turn gives E-3 a
  // real mid-hit session, a later first hit and a switch cost, without
  // depending on a particular classifier answer. Choose a phrase unique to
  // that turn across every replayed session.
  // The first turn of a mid-hit session must have a known actual member, so
  // the synthetic late rule can show a real switch cost.
  const midBase = baseRun.result.sessions.find((session: any) => session.turns >= 4 && session.rows[0].initialMember);
  assert.ok(midBase, "E-3 needs a multi-turn session with a known initial member");
  const targetTurn = Math.min(4, midBase.turns);
  const targetRow = midBase.rows[targetTurn - 1];
  const others = baseRun.result.sessions
    .flatMap((session: any) => session.rows)
    .filter((row: any) => row.id !== targetRow.id)
    .map((row: any) => row.fullText);
  const chars = Array.from(targetRow.fullText);
  let phrase = "";
  for (let length = 16; length <= 64 && !phrase; length += 4) {
    for (let start = 0; start + length <= chars.length; start++) {
      const candidate = chars.slice(start, start + length).join("");
      if (!candidate.includes("\n") && !others.some((text: string) => text.includes(candidate))) {
        phrase = candidate;
        break;
      }
    }
  }
  assert.ok(phrase, "E-3 must find a phrase unique to a later turn");
  const previousMember = midBase.rows[targetTurn - 2]?.draft.member || midBase.rows[targetTurn - 1].initialMember;
  const switchTo = group.members.find((member: string) => member !== previousMember) ?? timingOther;
  const timingDraft = structuredClone(draft);
  timingDraft.rules.push({ use: switchTo, where: [{ field: "message", op: "contains", value: phrase }] });
  const timingRun = await run({ group: group.id, draft: timingDraft, sessions: timingIds, k: 3, includeSubagents: false, stopAfterHit: false });
  artifact.timing = { base: baseRun.result, midPhrase: phrase, midTurn: targetTurn, result: timingRun.result };
  assert.ok(timingRun.result.sessions.some((session: any) => session.class === "mid"), "E-3 must exercise a mid-hit session");
  assert.ok(timingRun.result.summary.timing.main.midCost.switches > 0, "E-3 mid hit must carry a switch cost");
  assert.equal(timingRun.result.sessions.length, 4, "E-3 must return all four selected sessions");
  const byId = new Map(timingRun.result.sessions.map((session: any) => [session.id, session]));
  const histogram: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4-5": 0, "6-10": 0, ">10": 0 };
  const classes: Record<string, number> = { single: 0, early: 0, mid: 0, miss: 0 };
  for (const id of timingIds) {
    const session: any = byId.get(id);
    assert.ok(session, `session ${id} must be in the timing run`);
    const expectedFirst = session.rows.find((row: any) => !row.draft.stopped && row.draft.rule > 0)?.turn ?? null;
    assert.equal(session.firstHit, expectedFirst, `session ${id} firstHit must be the first draft rule hit`);
    const expectedClass = session.turns === 1 ? "single" : expectedFirst === null ? "miss" : expectedFirst <= 3 ? "early" : "mid";
    assert.equal(session.class, expectedClass, `session ${id} class`);
    classes[expectedClass]++;
    // Single-turn sessions are counted on their own and stay out of the
    // first-hit histogram, exactly as timingOf does.
    if (expectedFirst !== null && expectedClass !== "single") {
      const bin = expectedFirst === 1 ? "1" : expectedFirst === 2 ? "2" : expectedFirst === 3 ? "3" : expectedFirst <= 5 ? "4-5" : expectedFirst <= 10 ? "6-10" : ">10";
      histogram[bin]++;
    }
    const switched = session.rows.filter((row: any) => row.draft.switched);
    assert.equal(session.switched, switched.length > 0, `session ${id} switch flag`);
    assert.equal(session.prefixTokens, switched.reduce((sum: number, row: any) => sum + row.draft.prefixTokens, 0), `session ${id} switch cost`);
    if (switched.length) {
      assert.equal(session.from, switched[0].draft.from, `session ${id} switch from`);
      assert.equal(session.to, switched[0].draft.member, `session ${id} switch to`);
    }
  }
  assert.equal(classes.single, 1, "one single-turn session must be counted separately");
  assert.equal(timingRun.result.summary.timing.main.single, classes.single);
  assert.equal(timingRun.result.summary.timing.main.early, classes.early);
  assert.equal(timingRun.result.summary.timing.main.mid, classes.mid);
  assert.equal(timingRun.result.summary.timing.main.miss, classes.miss);
  assert.equal(timingRun.result.summary.timing.main.multi, classes.early + classes.mid + classes.miss);
  for (const bin of Object.keys(histogram)) {
    assert.equal(timingRun.result.summary.timing.main.histogram[bin], histogram[bin], `histogram bin ${bin}`);
  }
  const midRows = timingRun.result.sessions
    .filter((session: any) => session.class === "mid")
    .flatMap((session: any) => session.rows.filter((row: any) => row.draft.switched));
  const midCosts = midRows.map((row: any) => row.draft.prefixTokens).sort((a: number, b: number) => a - b);
  const midMedian = midCosts.length
    ? Math.round(midCosts.length % 2 ? midCosts[(midCosts.length - 1) / 2] : (midCosts[midCosts.length / 2 - 1] + midCosts[midCosts.length / 2]) / 2)
    : 0;
  assert.equal(timingRun.result.summary.timing.main.midCost.switches, midCosts.length);
  assert.equal(timingRun.result.summary.timing.main.midCost.prefixTokens, midCosts.reduce((sum: number, value: number) => sum + value, 0));
  assert.equal(timingRun.result.summary.timing.main.midCost.median, midMedian);
  check("E-3 timing classes, firstHit, histogram and mid-hit cost", {
    classes, histogram, midCost: timingRun.result.summary.timing.main.midCost,
  });

  // E-4: stopAfterHit must skip the draft's later turns and strictly cut
  // actual Jev requests. Two fresh service processes give both runs an empty
  // cache, so the count is not hidden by the first run's answers.
  // Step 6 wrote the edited draft into the sandbox, so current and edited now
  // ask identical Jev questions: the current side asks first and the draft
  // side only ever hits. The original intent differs from the sandbox current
  // in the request bytes (the draft asks its own answers) and still hits early
  // in these sessions.
  const e4Draft = draft;
  const labOff = await startLab(join(sandbox, "cache-off"));
  let e4Off: any;
  try {
    e4Off = await labOff.run({ group: group.id, draft: e4Draft, sessions: timingIds, k: 3, includeSubagents: false, stopAfterHit: false });
  } finally {
    await labOff.stop();
  }
  const labOn = await startLab(join(sandbox, "cache-on"));
  let e4On: any;
  try {
    e4On = await labOn.run({ group: group.id, draft: e4Draft, sessions: timingIds, k: 3, includeSubagents: false, stopAfterHit: true });
  } finally {
    await labOn.stop();
  }
  const offRequests = e4Off.result.summary.jev.draft.requests;
  const onRequests = e4On.result.summary.jev.draft.requests;
  assert.ok(offRequests > 0, "the stop-off draft must make actual Jev requests");
  assert.ok(onRequests < offRequests, `stopAfterHit must make fewer draft requests: ${onRequests} !< ${offRequests}`);
  const offSessions = new Map(e4Off.result.sessions.map((session: any) => [session.id, session]));
  const onSessions = new Map(e4On.result.sessions.map((session: any) => [session.id, session]));
  for (const id of timingIds) {
    const a: any = offSessions.get(id), b: any = onSessions.get(id);
    assert.ok(a && b, `E-4 session ${id} must be in both runs`);
    assert.equal(b.class, a.class, `E-4 session ${id} class must not change`);
    assert.equal(b.firstHit, a.firstHit, `E-4 session ${id} firstHit must not change`);
  }
  assert.ok(e4On.result.sessions.some((session: any) => session.rows.some((row: any) => row.draft.stopped)), "stopAfterHit must mark later turns unjudged");
  artifact.stopAfterHit = {
    offDraftRequests: offRequests, onDraftRequests: onRequests,
    offAll: e4Off.result.summary.jev, onAll: e4On.result.summary.jev,
    classes: e4On.result.sessions.map((session: any) => ({ id: session.id, class: session.class, firstHit: session.firstHit, stopped: session.rows.filter((row: any) => row.draft.stopped).length })),
  };
  console.log(`E-4 offDraftRequests=${offRequests} onDraftRequests=${onRequests} classes=${e4On.result.sessions.map((session: any) => `${session.class}/${session.firstHit}`).join(",")}`);
  check("E-4 stopAfterHit cuts draft Jev requests; class/firstHit identical", {
    offDraftRequests: offRequests, onDraftRequests: onRequests,
  });

  // F-3: the parent and every subagent replay as their own conversation.
  const f3Run = await run({ group: group.id, draft: edited, sessions: [fParent.id], k: 3, stopAfterHit: true });
  artifact.subagents = {
    parent: fParent.id,
    expected: fChildren.length,
    sessions: f3Run.result.sessions.map((session: any) => ({
      id: session.id, parentId: session.parentId ?? null, subagentId: session.subagentId ?? null,
      turns: session.turns, rows: session.rows.length, class: session.class,
      initial: session.rows[0]?.initialMember ?? "",
    })),
    summary: f3Run.result.summary.timing,
  };
  const f3Sessions = f3Run.result.sessions;
  const f3Main = f3Sessions.filter((session: any) => !session.parentId);
  const f3Subs = f3Sessions.filter((session: any) => session.parentId === fParent.id);
  assert.equal(f3Main.length, 1, "F-3 must return one main session");
  assert.equal(f3Subs.length, fChildren.length, "F-3 must return one result per subagent");
  for (const result of [f3Main[0], ...f3Subs]) {
    assert.ok(result.turns >= 1, `F-3 ${result.id} must have turns`);
    assert.equal(result.rows.length, result.turns, `F-3 ${result.id} rows must equal its own turns`);
    for (let i = 0; i < result.rows.length; i++) {
      assert.equal(result.rows[i].turn, i + 1, `F-3 ${result.id} turns must be 1..n`);
      assert.equal(result.rows[i].session, sessionPath(result.id), `F-3 ${result.id} rows must belong to its own transcript`);
    }
  }
  const parentInitial = f3Main[0].rows[0].initialMember;
  for (const sub of f3Subs) {
    const own = await readHistory({ sessions: [sessionPath(sub.id)], all: true });
    const expected = own.samples[0]?.initialMembers[group.id] ?? "";
    assert.equal(sub.rows[0].initialMember, expected, `F-3 subagent ${sub.subagentId} initial member must come from its own routing record`);
  }
  if (parentInitial) {
    assert.ok(f3Subs.some((sub: any) => !sub.rows[0].initialMember), "F-3 a subagent with no own routing row must be unknown, not inherit the parent");
  }
  const timingFor = (list: any[]) => {
    const counts: Record<string, number> = { single: 0, early: 0, mid: 0, miss: 0 };
    const histogram: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4-5": 0, "6-10": 0, ">10": 0 };
    const costs: number[] = [];
    let prefixTokens = 0;
    for (const session of list) {
      const first = session.rows.find((row: any) => !row.draft.stopped && row.draft.rule > 0)?.turn ?? null;
      const cls = session.turns === 1 ? "single" : first === null ? "miss" : first <= 3 ? "early" : "mid";
      assert.equal(session.class, cls, `F-3 ${session.id} class`);
      counts[cls]++;
      if (first !== null && cls !== "single") {
        const bin = first === 1 ? "1" : first === 2 ? "2" : first === 3 ? "3" : first <= 5 ? "4-5" : first <= 10 ? "6-10" : ">10";
        histogram[bin]++;
      }
      if (cls !== "mid") continue;
      for (const row of session.rows) {
        if (!row.draft.switched) continue;
        costs.push(row.draft.prefixTokens);
        prefixTokens += row.draft.prefixTokens;
      }
    }
    costs.sort((a, b) => a - b);
    const median = costs.length
      ? Math.round(costs.length % 2 ? costs[(costs.length - 1) / 2] : (costs[costs.length / 2 - 1] + costs[costs.length / 2]) / 2)
      : 0;
    return {
      ...counts, multi: counts.early + counts.mid + counts.miss, histogram,
      midCost: { switches: costs.length, prefixTokens, median },
    };
  };
  const expectedMain = timingFor(f3Main);
  const expectedSubs = timingFor(f3Subs);
  for (const side of ["main", "subagents"] as const) {
    const expected = side === "main" ? expectedMain : expectedSubs;
    const got = f3Run.result.summary.timing[side];
    for (const key of ["single", "early", "mid", "miss", "multi"]) assert.equal(got[key], (expected as any)[key], `F-3 ${side} ${key}`);
    for (const bin of Object.keys(expected.histogram)) assert.equal(got.histogram[bin], expected.histogram[bin], `F-3 ${side} histogram ${bin}`);
    assert.equal(got.midCost.switches, expected.midCost.switches, `F-3 ${side} midCost switches`);
    assert.equal(got.midCost.prefixTokens, expected.midCost.prefixTokens, `F-3 ${side} midCost tokens`);
    assert.equal(got.midCost.median, expected.midCost.median, `F-3 ${side} midCost median`);
  }
  const f3Only = await run({ group: group.id, draft: edited, sessions: [fParent.id], k: 3, includeSubagents: false, stopAfterHit: true });
  artifact.subagents.mainOnly = f3Only.result.sessions.map((session: any) => ({ id: session.id, parentId: session.parentId ?? null, turns: session.turns }));
  assert.equal(f3Only.result.sessions.length, 1, "F-3 includeSubagents=false must return only the main session");
  assert.ok(!f3Only.result.sessions[0].parentId, "F-3 main-only result must not be a subagent");
  assert.equal(f3Only.result.sessions[0].turns, f3Main[0].turns, "F-3 main-only result must have the main session's turns");
  console.log(`F-3 parentTurns=${f3Main[0].turns} subagents=${f3Subs.length} main=${JSON.stringify(expectedMain)} subs=${JSON.stringify(expectedSubs)} initial=${JSON.stringify([{ parent: parentInitial }, ...f3Subs.map((sub: any) => ({ id: sub.subagentId, initial: sub.rows[0].initialMember }))])}`);
  check("F-3 subagents replay independently; split summary sums each part; toggle works", {
    parentTurns: f3Main[0].turns, subagents: f3Subs.length,
    main: expectedMain, subagentsTiming: expectedSubs,
  });
  // 12: rerun the turnIn probe over every sample the plugin produces. A
  // sample must be the message that opened a new turn (turnIn within false);
  // the messages turnIn keeps inside the previous turn are not samples.
  const all = await readHistory({ limit: 10_000, all: true });
  let withinSamples = 0;
  for (const sample of all.samples) {
    const transcript = await readTranscript(sample.session, sample.agent);
    const message = transcript.messages[sample.message];
    assert.ok(message && message.Role === "user", `sample ${sample.id} must point at a user message`);
    assert.equal(userSaid(message), sample.fullText, `sample ${sample.id} text must match its transcript message`);
    const state = turnIn(transcript.messages.slice(0, sample.message + 1));
    if (state.within) withinSamples++;
  }
  assert.equal(withinSamples, 0, "no plugin sample may be within a turn");
  assert.ok(all.stats.skippedWithin > 0, "D1 must exclude the within-turn messages it used to sample");
  artifact.d1 = {
    samples: all.samples.length,
    excludedWithin: all.stats.skippedWithin,
    withinSamples,
    turns: all.stats.turns,
  };
  console.log(`D1 samples=${all.samples.length} excludedWithin=${all.stats.skippedWithin} withinSamples=${withinSamples}`);
  check("12 D1 samples open a new turn; within-turn messages excluded", {
    samples: all.samples.length, excludedWithin: all.stats.skippedWithin,
  });
  // 13: session stickiness. The edited draft makes some turns hit the rule;
  // claude-opus is affinity=session, so every later non-hit turn in that
  // session must stay on the previous actual member (stickyWhy kept), and
  // only a change of actual member counts as a switch.
  assert.equal(group.affinity, "session", "this check is written for the real claude-opus affinity");
  // Pick a real multi-turn session and aim the original intent rule at a
  // member other than that session's first actual member. Step 6 wrote the
  // edited intent into the sandbox current group; the draft keeps the
  // original intent (the one that classifies a reseller chat) and only
  // changes `use`, so its first rule hit must move the session to the other
  // member, while later non-hit turns stay there by affinity.
  const switchSearch = await json(`/api/sessions?q=${encodeURIComponent("llm reseller")}&scopes=first&limit=20`);
  const switchCandidates = switchSearch.sessions.filter((session: any) => session.first.includes("我想做llm reseller") && session.turns > 1);
  assert.ok(switchCandidates.length, "a multi-turn session for the stickiness check must exist");
  let switchSession: any = null, switchInitial = "";
  for (const candidate of switchCandidates) {
    const own = await readHistory({ sessions: [sessionPath(candidate.id)], all: true });
    const initial = own.samples[0]?.initialMembers[group.id] ?? "";
    if (initial) { switchSession = candidate; switchInitial = initial; break; }
  }
  assert.ok(switchSession, "the stickiness session must have a known first actual member");
  const switchUse = group.members.find((member: string) => member !== switchInitial);
  assert.ok(switchUse, "claude-opus must have a member other than the session's initial one");
  const stickyDraft = structuredClone(draft);
  for (const rule of stickyDraft.rules) if (rule.intent) rule.use = switchUse;
  const stickyRun = await run({ group: group.id, draft: stickyDraft, sessions: [switchSession.id], k: 3, includeSubagents: false, stopAfterHit: false });
  const stickyRows = stickyRun.result.sessions.flatMap((session: any) => session.rows);
  const bySession = new Map<string, any[]>();
  for (const row of stickyRows) {
    const list = bySession.get(row.session);
    if (list) list.push(row); else bySession.set(row.session, [row]);
  }
  const sideCounts: Record<string, number> = { current: 0, draft: 0 };
  let hitRows = 0, keptAfterHit = 0, switchedRows = 0;
  for (const side of ["current", "draft"] as const) {
    let switches = 0, prefixTokens = 0;
    for (const rows of bySession.values()) {
      let previous = rows[0].initialMember || "";
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i], result = row[side];
        assert.ok(["rule", "kept", "initial", "unknown"].includes(result.stickyWhy), `row ${row.id} ${side} stickyWhy`);
        assert.equal(typeof result.member, "string", `row ${row.id} ${side} member`);
        assert.equal(typeof result.from, "string", `row ${row.id} ${side} from`);
        assert.equal(result.from, i === 0 ? (row.initialMember || "") : previous, `row ${row.id} ${side} from must be the previous member`);
        if (result.rule > 0) {
          hitRows++;
          assert.equal(result.stickyWhy, "rule", `row ${row.id} ${side} rule hit must say rule`);
          assert.equal(result.member, result.use, `row ${row.id} ${side} rule hit must use the rule member`);
        } else if (i > 0 && previous && rows.slice(0, i).some(prior => prior[side].rule > 0)) {
          keptAfterHit++;
          assert.equal(result.stickyWhy, "kept", `row ${row.id} ${side} after a hit must stay by affinity`);
          assert.equal(result.member, previous, `row ${row.id} ${side} after a hit must keep the previous member`);
        }
        if (result.switched) {
          switchedRows++;
          assert.notEqual(result.member, result.from, `row ${row.id} ${side} switched must change member`);
          assert.ok(result.prefixTokens > 0, `row ${row.id} ${side} switch must carry prefix tokens`);
        }
        if (result.from && result.member) {
          assert.equal(result.switched, result.from !== result.member, `row ${row.id} ${side} switched must mean a member change`);
        }
        if (result.switched) { switches++; prefixTokens += result.prefixTokens; }
        previous = result.member;
      }
    }
    assert.equal(stickyRun.result.summary.sticky[side].switches, switches, `${side} summary switch count must sum rows`);
    assert.equal(stickyRun.result.summary.sticky[side].prefixTokens, prefixTokens, `${side} summary prefix tokens must sum switched rows`);
    const switchedSessions = new Set(stickyRows.filter(row => row[side].switched).map(row => row.session)).size;
    assert.equal(stickyRun.result.summary.sticky[side].sessions, switchedSessions, `${side} summary switched session count`);
    sideCounts[side] = switches;
  }
  assert.ok(hitRows > 0, "the draft must hit some turns");
  assert.ok(keptAfterHit > 0, "a hit must be followed by a kept non-hit turn");
  assert.ok(switchedRows > 0, "at least one row must switch members");
  artifact.sticky = { rows: stickyRows.length, sideCounts, hitRows, keptAfterHit, switchedRows, summary: stickyRun.result.summary.sticky };
  console.log(`D2 rows=${stickyRows.length} hits=${hitRows} keptAfterHit=${keptAfterHit} switched=${switchedRows} currentSwitches=${sideCounts.current} draftSwitches=${sideCounts.draft}`);
  check("13 session stickiness: kept after hit, switches only on member change, summary sums", {
    rows: stickyRows.length, hitRows, keptAfterHit, switchedRows, sideCounts,
  });

  // F-4: what agent does magpie's routing log show for the plugin's own Jev
  // calls? Printed, not asserted.
  const routingDir = join(homedir(), ".config/magpie/routing");
  const startedAt = Date.parse(artifact.started);
  const jevAgents: Record<string, number> = {};
  let jevRows = 0;
  try {
    for (const name of (await readdir(routingDir)).filter(name => name.endsWith(".jsonl"))) {
      const text = await readFile(join(routingDir, name), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        if (Date.parse(row?.time) < startedAt) continue;
        const isJev = row?.model === "typesafe/jev-latest" || (row?.usage ?? []).some((u: any) => String(u?.model ?? "").includes("jev"));
        if (!isJev) continue;
        const agent = String(row.agent ?? "(none)");
        jevAgents[agent] = (jevAgents[agent] ?? 0) + 1;
        jevRows++;
      }
    }
  } catch { /* the log is evidence, not a gate */ }
  artifact.jevAgent = { rows: jevRows, agents: jevAgents };
  console.log(`F-4 plugin Jev requests during e2e (${jevRows}): ${Object.keys(jevAgents).length ? Object.entries(jevAgents).map(([agent, count]) => `${agent}=${count}`).join(", ") : "(none found)"}`);
  check("F-4 plugin Jev requests logged as agent", { rows: jevRows, agents: jevAgents });
  artifact.status = "PASS";
} catch (error: any) {
  artifact.status = "FAIL";
  artifact.error = error.stack ?? String(error);
  console.error(artifact.error);
  process.exitCode = 1;
} finally {
  child.kill();
  await child.exited;
  await stdout;
  artifact.finished = new Date().toISOString();
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), { mode: 0o600 });
  if (artifact.status === "PASS") await rm(sandbox, { recursive: true, force: true });
  console.log(`artifacts: ${artifactPath}`);
}
