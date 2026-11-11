import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let chromium: any;
try {
  ({ chromium } = await import("playwright"));
} catch {
  throw new Error("ui-shot 需要 Playwright：bun add -d playwright（或安装 Chromium 后重试）");
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactDir = join(root, "artifacts");
await mkdir(artifactDir, { recursive: true, mode: 0o700 });

const child = Bun.spawn([process.execPath, join(root, "src/server.ts")], {
  cwd: root,
  env: { ...process.env, INTENT_LAB_PORT: "0" },
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

async function launch() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
  }
}

async function noHorizontalScroll(page: any, width: number) {
  const sizes = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  if (sizes.scroll > sizes.client || sizes.body > sizes.client) {
    throw new Error(`${width}px viewport has horizontal scroll: ${JSON.stringify(sizes)}`);
  }
  return sizes;
}

let browser: any;
try {
  const deadline = Date.now() + 15_000;
  while (!base && Date.now() < deadline && child.exitCode === null) await Bun.sleep(50);
  if (!base) throw new Error("service did not announce a loopback port");

  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: "light" });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="group-select"] option').length > 0);
  await page.selectOption('[data-testid="group-select"]', "claude-opus");
  await page.fill('[data-testid="limit-input"]', "20");
  await page.click('[data-testid="run-button"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="result-table"] tbody tr.result-row').length > 0,
    undefined,
    { timeout: 240_000 },
  );
  await page.waitForTimeout(300);

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.screenshot({ path: join(artifactDir, "ui-1100.png"), fullPage: true });
  console.log("PASS ui-1100.png");

  await page.setViewportSize({ width: 420, height: 900 });
  const light420 = await noHorizontalScroll(page, 420);
  await page.screenshot({ path: join(artifactDir, "ui-420.png"), fullPage: true });
  console.log("PASS ui-420.png", JSON.stringify(light420));

  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(artifactDir, "ui-1100-dark.png"), fullPage: true });
  console.log("PASS ui-1100-dark.png");

  await page.setViewportSize({ width: 420, height: 900 });
  const dark420 = await noHorizontalScroll(page, 420);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(artifactDir, "ui-420-dark.png"), fullPage: true });
  console.log("PASS ui-420-dark.png", JSON.stringify(dark420));

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator("#logic-panel").screenshot({ path: join(artifactDir, "logic-1100.png") });
  console.log("PASS logic-1100.png");
  await page.setViewportSize({ width: 420, height: 900 });
  const logic420 = await noHorizontalScroll(page, 420);
  await page.locator("#logic-panel").screenshot({ path: join(artifactDir, "logic-420.png") });
  console.log("PASS logic-420.png", JSON.stringify(logic420));

  await page.setViewportSize({ width: 1100, height: 900 });
  let searched = false;
  for (const term of ["git", "the"]) {
    await page.fill('[data-testid="session-search"]', term);
    for (const scope of ["user", "reply", "bash"]) await page.check(`input.scope[value="${scope}"]`);
    await page.click('[data-testid="session-search-button"]');
    try {
      await page.waitForSelector(".session-card", { timeout: 60_000 });
      searched = true;
      break;
    } catch { /* try the next common word */ }
  }
  if (!searched) throw new Error("ui-shot session search listed no sessions");
  await page.locator("#session-panel").screenshot({ path: join(artifactDir, "sessions-1100.png") });
  console.log("PASS sessions-1100.png");
  await page.setViewportSize({ width: 420, height: 900 });
  const sessions420 = await noHorizontalScroll(page, 420);
  await page.locator("#session-panel").screenshot({ path: join(artifactDir, "sessions-420.png") });
  console.log("PASS sessions-420.png", JSON.stringify(sessions420));

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.click('[data-testid="session-preview"]');
  await page.waitForSelector("#session-modal:not([hidden])");
  await page.locator("#session-modal .modal-dialog").screenshot({ path: join(artifactDir, "preview-1100.png") });
  console.log("PASS preview-1100.png");
  await page.setViewportSize({ width: 420, height: 900 });
  const preview420 = await noHorizontalScroll(page, 420);
  await page.locator("#session-modal .modal-dialog").screenshot({ path: join(artifactDir, "preview-420.png") });
  console.log("PASS preview-420.png", JSON.stringify(preview420));
  await page.keyboard.press("Escape");
  await page.waitForSelector("#session-modal", { state: "hidden" });

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.click('[data-testid="result-table"] tbody tr.result-row');
  await page.waitForSelector("tr.detail");
  await page.locator("tr.detail").screenshot({ path: join(artifactDir, "trace-1100.png") });
  console.log("PASS trace-1100.png");
  await page.setViewportSize({ width: 420, height: 900 });
  const trace420 = await noHorizontalScroll(page, 420);
  await page.locator("tr.detail").screenshot({ path: join(artifactDir, "trace-420.png") });
  console.log("PASS trace-420.png", JSON.stringify(trace420));

  // A second run restricted to one known session, with a draft that hits the
  // rule, shows the actual-model columns and a switch marker. Restricting the
  // session keeps the screenshot and the classifier calls small.
  await page.setViewportSize({ width: 1100, height: 900 });
  // The earlier screenshots left a search active; clear it so the next
  // waitForSelector cannot match its stale cards.
  await page.click("#session-clear");
  await page.fill('[data-testid="session-search"]', "cheaperinference");
  await page.check('input.scope[value="user"]');
  await page.click('[data-testid="session-search-button"]');
  await page.waitForFunction(
    () => (document.querySelector("#session-status")?.textContent || "").includes("命中"),
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForSelector(".session-card", { timeout: 60_000 });
  await page.evaluate(() => {
    // Match the session's own first message, not the whole card: snippets
    // quote any user text, including this script's own phrase, and selecting
    // one of those would replay the wrong session.
    const cards = [...document.querySelectorAll(".session-card")];
    const target = cards.find(card => (card.querySelector(".session-first")?.textContent || "").includes("我想做llm reseller"));
    if (!target) throw new Error("switch screenshot session not found");
    for (const card of cards) {
      if (card === target) continue;
      const box = card.querySelector('[data-testid="session-checkbox"]');
      if (box?.checked) {
        box.checked = false;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    const box = target.querySelector('[data-testid="session-checkbox"]');
    if (!box?.checked) {
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    for (const input of document.querySelectorAll('#draft-rules input[type="text"]')) {
      input.value = "写代码或改代码";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  const selected = await page.evaluate(() => state.selectedSessions.size);
  if (selected !== 1) throw new Error(`expected one selected session for the switch screenshot, got ${selected}`);
  const rowsBefore = await page.locator('[data-testid="result-table"] tbody tr.result-row').count();
  await page.click('[data-testid="run-button"]');
  // The first run's rows stay in the table until the second result arrives.
  await page.waitForFunction(
    previous => {
      const count = document.querySelectorAll('[data-testid="result-table"] tbody tr.result-row').length;
      return count > 0 && count !== previous;
    },
    rowsBefore,
    { timeout: 300_000 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="switch-mark"]').length > 0,
    undefined,
    { timeout: 30_000 },
  );
  const switchMarks = await page.locator('[data-testid="switch-mark"]').count();
  await page.locator("#results-panel").screenshot({ path: join(artifactDir, "results-1100.png") });
  console.log(`PASS results-1100.png switches=${switchMarks}`);
  await page.setViewportSize({ width: 420, height: 900 });
  const results420 = await noHorizontalScroll(page, 420);
  await page.locator("#results-panel").screenshot({ path: join(artifactDir, "results-420.png") });
  console.log("PASS results-420.png", JSON.stringify(results420));

  const shots = ["ui-1100.png", "ui-420.png", "ui-1100-dark.png", "ui-420-dark.png", "logic-1100.png", "logic-420.png", "sessions-1100.png", "sessions-420.png", "preview-1100.png", "preview-420.png", "trace-1100.png", "trace-420.png", "results-1100.png", "results-420.png"];
  console.log(`artifacts: ${shots.map(name => join(artifactDir, name)).join(", ")}`);
} finally {
  if (browser) await browser.close();
  child.kill();
  await child.exited;
  await stdout;
}
