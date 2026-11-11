import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const response = await fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
async function run(body: unknown) {
  const response = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
  assert.match(await page.text(), /Intent Lab/);
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
