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
  await page.waitForSelector("#session-list .session-card", { timeout: 60_000 });

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
  await page.locator("#session-panel").screenshot({ path: join(artifactDir, "panel-1100.png") });
  console.log("PASS panel-1100.png");
  await page.setViewportSize({ width: 420, height: 900 });
  const panel420 = await noHorizontalScroll(page, 420);
  await page.locator("#session-panel").screenshot({ path: join(artifactDir, "panel-420.png") });
  console.log("PASS panel-420.png", JSON.stringify(panel420));

  await page.setViewportSize({ width: 1100, height: 900 });
  // Make the screenshot show hit turns, not an all-miss timeline.
  await page.evaluate(() => {
    for (const input of document.querySelectorAll('#draft-rules input[type="text"]')) {
      input.value = "写代码或改代码";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.click('[data-testid="session-select-none"]');
  const boxes = await page.$$('[data-testid="session-checkbox"]');
  if (boxes.length < 3) throw new Error(`need at least 3 sessions for screenshots, got ${boxes.length}`);
  for (const box of boxes.slice(0, 3)) await box.check();
  const selected = await page.evaluate(() => state.selectedSessions.size);
  if (selected !== 3) throw new Error(`expected 3 selected sessions, got ${selected}`);
  await page.click('[data-testid="run-button"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="session-result"]').length === 3,
    undefined,
    { timeout: 300_000 },
  );
  await page.waitForSelector('[data-testid="turn-cell"]', { timeout: 10_000 });
  await page.locator("#results-panel").screenshot({ path: join(artifactDir, "main-1100.png") });
  console.log("PASS main-1100.png");
  await page.setViewportSize({ width: 420, height: 900 });
  const main420 = await noHorizontalScroll(page, 420);
  await page.locator("#results-panel").screenshot({ path: join(artifactDir, "main-420.png") });
  console.log("PASS main-420.png", JSON.stringify(main420));

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.click('[data-testid="session-result-head"]');
  await page.waitForSelector('[data-testid="turn-row"]', { timeout: 10_000 });
  const expanded = page.locator("#session-results .session-result").first();
  await expanded.screenshot({ path: join(artifactDir, "expanded-1100.png") });
  console.log("PASS expanded-1100.png");
  await page.setViewportSize({ width: 420, height: 900 });
  const expanded420 = await noHorizontalScroll(page, 420);
  await expanded.screenshot({ path: join(artifactDir, "expanded-420.png") });
  console.log("PASS expanded-420.png", JSON.stringify(expanded420));

  const shots = ["ui-1100.png", "ui-420.png", "ui-1100-dark.png", "ui-420-dark.png", "logic-1100.png", "logic-420.png", "panel-1100.png", "panel-420.png", "main-1100.png", "main-420.png", "expanded-1100.png", "expanded-420.png"];
  console.log(`artifacts: ${shots.map(name => join(artifactDir, name)).join(", ")}`);
} finally {
  if (browser) await browser.close();
  child.kill();
  await child.exited;
  await stdout;
}
