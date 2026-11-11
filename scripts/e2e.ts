import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory, readTranscript } from "../src/history";
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
const cliEnv = { XDG_CONFIG_HOME: sandbox, HOME: sandboxHome };

const artifact: any = { started: new Date().toISOString(), checks: [], configBefore, sandbox: { xdg: sandbox, home: sandboxHome } };
const child = Bun.spawn([process.execPath, join(root, "src/server.ts")], {
  cwd: root,
  env: { ...process.env, INTENT_LAB_PORT: "0", INTENT_LAB_MAGPIE_ENV: JSON.stringify(cliEnv) },
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
  const response = await fetch(base + path, body === undefined ? { headers: auth() } : {
    method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify(body),
  });
  if (!response.ok) throw Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
async function run(body: unknown) {
  const response = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify(body) });
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
  const draft = { rules: structuredClone(group.rules), intentSure: group.intentSure };
  const same = await run({ group: group.id, draft, limit: 30 });
  artifact.identical = same;
  assert.ok(same.result.rows.length >= 1);
  assert.ok(same.result.rows.every((r: any) => r.changed === false), "identical rules must produce identical rows");
  assert.equal(same.result.summary.changed, 0);
  check("3 identical draft changed=0", { rows: same.result.rows.length, cache: same.result.cache });
  const edited = structuredClone(draft);
  for (const rule of edited.rules) if (rule.intent) rule.intent = "写代码或改代码";
  const changed = await run({ group: group.id, draft: edited, limit: 30 });
  artifact.edited = changed;
  assert.ok(changed.result.rows.some((r: any) => r.changed === true), "edited intent must change at least one row");
  assert.ok(changed.result.summary.changed > 0);
  check(`4 edited intent changed=${changed.result.summary.changed}`, { rows: changed.result.rows.length, cache: changed.result.cache });
  const commands = await json("/api/apply", { group: group.id, draft: edited, dryRun: true });
  artifact.apply = commands;
  assert.ok(Array.isArray(commands.commands) && commands.commands.length > 0);
  assert.ok(commands.commands.some((c: string) => /group rule rm/.test(c)));
  assert.ok(commands.commands.some((c: string) => /group rule add/.test(c) && c.includes("写代码或改代码") && c.includes("at=")));
  check("5 apply dryRun commands", { commands: commands.commands.length });
  const real = await json("/api/apply", { group: group.id, draft: edited, dryRun: false });
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
  const sandboxConfig = await readFile(join(sandbox, "magpie/providers.json"), "utf8");
  assert.match(sandboxConfig, /写代码或改代码/, "the sandbox providers.json must have changed");
  artifact.configAfter = await digest();
  assert.equal(artifact.configAfter, configBefore, "real configuration must remain byte-for-byte unchanged");
  check("6 sandboxed real apply; readback has new intent; real config unchanged", {
    executed: real.executed.length,
    readBack: real.readBack.split("\n").filter(Boolean).slice(0, 3),
  });
  const html = await (await fetch(base + "/")).text();
  const anchors = ["draft-editor", "run-button", "result-table", "group-select", "limit-input", "summary", "apply-preview", "apply-run"];
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
  const firstMessage = samples.samples[0].fullText || samples.samples[0].text;
  const word = (firstMessage.match(/[A-Za-z][A-Za-z0-9_-]{2,}/) ?? firstMessage.match(/\p{L}{2,}/) ?? ["git"])[0];
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
  // 10: two selected sessions. Every returned row must belong to one of
  // them, and each session's rows must equal its in-range turn count.
  const picked = firstSearch.sessions.slice(0, 2);
  assert.equal(picked.length, 2, "the first search must return at least two sessions for this check");
  const restricted = await run({ group: group.id, draft, sessions: picked.map((session: any) => session.id) });
  artifact.sessionRun = { picked: picked.map((session: any) => ({ id: session.id, turns: session.turns })), rows: restricted.result.rows.length };
  assert.ok(restricted.result.rows.length > 0, "selected sessions must replay turns");
  const allowed = new Set(picked.map((session: any) => session.id));
  for (const row of restricted.result.rows) assert.ok(allowed.has(row.sessionId), `row ${row.id} is outside the picked sessions`);
  const counts = new Map<string, number>();
  for (const row of restricted.result.rows) counts.set(row.sessionId, (counts.get(row.sessionId) ?? 0) + 1);
  for (const session of picked) assert.equal(counts.get(session.id) ?? 0, session.turns, `session ${session.id} row count must equal its turn count`);
  check("10 selected sessions only; per-session row counts", { sessions: picked.length, rows: restricted.result.rows.length });
  // 11: every row carries the trace captured by the replay itself.
  for (const row of restricted.result.rows) {
    for (const side of ["current", "draft"] as const) {
      const trace = row[side]?.trace;
      assert.ok(trace, `row ${row.id} ${side} must have a trace`);
      assert.equal(trace.jevRequest.state.message, row.text, `row ${row.id} ${side} request message must be the replayed text`);
      assert.equal(trace.chosen.n, row[side].rule, `row ${row.id} ${side} chosen rule must match the result`);
      assert.equal(trace.ruleWalk.find((rule: any) => rule.chosen)?.n ?? 0, row[side].rule, `row ${row.id} ${side} rule walk must agree`);
      if (trace.jevAnswer?.topic) assert.equal(trace.passed, trace.sure >= trace.threshold, `row ${row.id} ${side} topic passed must be sure >= threshold`);
    }
  }
  check("11 per-row trace", { rows: restricted.result.rows.length, sides: ["current", "draft"] });
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
  // Pick a real multi-turn session and change the rule's use to the group's
  // other member. The same turns then hit on both sides, while the session
  // moves member in current (wokey) but not in draft (jmds).
  const switchSearch = await json(`/api/sessions?q=${encodeURIComponent("llm reseller")}&scopes=first&limit=20`);
  const switchSession = switchSearch.sessions.find((session: any) => session.first.includes("我想做llm reseller") && session.turns > 1);
  assert.ok(switchSession, "a multi-turn session for the stickiness check must exist");
  const currentUse = group.rules.find((rule: any) => rule.use)?.use;
  const otherMember = group.members.find((member: string) => member !== currentUse);
  assert.ok(currentUse && otherMember, "claude-opus must have two members to switch between");
  const stickyDraft = structuredClone(draft);
  for (const rule of stickyDraft.rules) rule.use = otherMember;
  const stickyRun = await run({ group: group.id, draft: stickyDraft, sessions: [switchSession.id] });
  const stickyRows = stickyRun.result.rows;
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
