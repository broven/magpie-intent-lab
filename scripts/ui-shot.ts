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
  console.log(`artifacts: ${join(artifactDir, "ui-1100.png")}, ${join(artifactDir, "ui-420.png")}, ${join(artifactDir, "ui-1100-dark.png")}, ${join(artifactDir, "ui-420-dark.png")}`);
} finally {
  if (browser) await browser.close();
  child.kill();
  await child.exited;
  await stdout;
}
