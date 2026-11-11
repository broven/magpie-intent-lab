// Loads the plugin the way magpie's window does: page/ in an iframe sandboxed
// to allow-scripts, served under magpie's page policy (pagePolicy in
// internal/gui/pluginpage.go), with a stand-in bridge. Passes only when the
// frame goes on to the service, the session list scrolls inside its panel,
// three selected sessions replay into the session-first view, and a session
// expands to its per-turn rows.
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import("playwright");
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const child = Bun.spawn([process.execPath, join(root, "src/server.ts")], {
  cwd: root, env: { ...process.env, INTENT_LAB_PORT: "0" }, stdout: "pipe", stderr: "inherit",
});
let service = "";
const reading = (async () => {
  const reader = child.stdout.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    const hit = /intent-lab listening (http:\/\/127\.0\.0\.1:(\d+))/.exec(buffer);
    if (hit) service = hit[1];
  }
})();

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml" };
let window_: ReturnType<typeof Bun.serve> | undefined;
let browser: any;
let failed = false;
try {
  const deadline = Date.now() + 15_000;
  while (!service && Date.now() < deadline) await Bun.sleep(50);
  if (!service) throw new Error("service did not start");
  const servicePort = new URL(service).port;

  // magpie's window: its own page holding the plugin's frame, and the
  // frame's files under the page policy.
  window_ = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") {
        return new Response(`<!doctype html><iframe id="f" sandbox="allow-scripts" style="width:1000px;height:800px" src="/plugin/index.html"></iframe>`, { headers: { "content-type": "text/html" } });
      }
      if (!path.startsWith("/plugin/")) return new Response("no", { status: 404 });
      const own = `http://${req.headers.get("host")}/plugin/`;
      const policy = [
        "sandbox allow-scripts", "default-src 'none'", `script-src ${own}`, `style-src ${own} 'unsafe-inline'`,
        `img-src ${own} data:`, `font-src ${own}`, `media-src ${own}`, "connect-src 'none'", "frame-src 'none'",
        "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
      ].join("; ");
      const rel = path.slice("/plugin/".length);
      let body: string | Blob;
      if (rel === "_magpie/bridge.js") {
        // stand-in for pagebridge.js: the desktop window gives no service
        body = `window.magpie = { ready: Promise.resolve({ dark: false }), service: "", options: { get: async () => ({ port: ${servicePort} }) } };`;
      } else {
        const file = Bun.file(join(root, "page", rel));
        if (rel.includes("..") || !(await file.exists())) return new Response("no", { status: 404 });
        body = file;
      }
      return new Response(body, { headers: { "content-type": types[extname(rel)] ?? "application/octet-stream", "content-security-policy": policy } });
    },
  });

  browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() =>
    chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }));
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${window_.port}/`);

  const end = Date.now() + 20_000;
  let frame: any;
  let options: string[] = [];
  while (Date.now() < end) {
    frame = page.frames().find((f: any) => f.url().startsWith(service));
    if (frame) {
      options = await frame.$$eval("#group-select option", (os: any[]) => os.map(o => o.value)).catch(() => []);
      if (options.length) break;
    }
    await Bun.sleep(200);
  }
  if (!frame) throw new Error(`the frame never went to the service; console errors: ${errors.join(" | ")}`);
  if (!options.length) throw new Error(`the interface listed no groups in the sandboxed frame; console errors: ${errors.join(" | ")}`);
  const origin = await frame.evaluate(() => self.origin);
  if (origin !== "null") throw new Error(`frame origin is ${origin}, expected opaque "null"`);

  const logicSteps = await frame.$$eval('[data-testid="logic-step"]', (nodes: any[]) => nodes.length);
  if (logicSteps !== 2) throw new Error(`decision-logic panel has ${logicSteps} steps, expected 2`);

  await frame.waitForSelector("#session-list .session-card", { timeout: 60_000 });
  const listScroll = await frame.$eval("#session-list", (node: any) => ({
    scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
  }));
  if (!(listScroll.scrollHeight > listScroll.clientHeight)) {
    throw new Error(`session list does not scroll internally: ${JSON.stringify(listScroll)}`);
  }

  await frame.click('[data-testid="session-select-none"]');
  const boxes = await frame.$$('[data-testid="session-checkbox"]');
  if (boxes.length < 3) throw new Error(`session list has ${boxes.length} sessions, need at least 3`);
  for (const box of boxes.slice(0, 3)) await box.check();
  const selected = await frame.evaluate(() => state.selectedSessions.size);
  if (selected !== 3) throw new Error(`expected 3 selected sessions, got ${selected}`);

  await frame.click('[data-testid="run-button"]');
  await frame.waitForFunction(
    () => document.querySelectorAll('[data-testid="session-result"]').length === 3,
    undefined,
    { timeout: 300_000 },
  );
  const timelineCells = await frame.$$eval('[data-testid="turn-cell"]', (nodes: any[]) => nodes.length);
  if (!timelineCells) throw new Error("session main view has no timeline cells");

  await frame.click('[data-testid="session-result-head"]');
  await frame.waitForSelector('[data-testid="turn-row"]', { timeout: 10_000 });
  const turnRows = await frame.$$eval('[data-testid="turn-row"]', (nodes: any[]) => nodes.length);
  if (!turnRows) throw new Error("expanded session has no per-turn rows");
  const headers = await frame.$$eval('[data-testid="result-table"] th', (nodes: any[]) => nodes.map(node => node.textContent));
  for (const wanted of ["当前 实际模型", "草稿 实际模型"]) {
    if (!headers.includes(wanted)) throw new Error(`turn table has no ${wanted} column: ${headers.join(" | ")}`);
  }
  await frame.click('[data-testid="turn-row"]');
  await frame.waitForSelector("tr.detail", { timeout: 10_000 });
  const detail = await frame.$eval("tr.detail", (node: any) => node.textContent ?? "");
  if (!detail.includes("判定过程")) throw new Error("expanded turn has no 判定过程 trace");
  if (!detail.includes("粘性")) throw new Error("expanded turn has no 粘性 trace");
  console.log(`PASS frame went to ${frame.url()} (origin ${origin}); groups: ${options.join(", ")}; logic steps: ${logicSteps}; sessions: 3; list scroll: ${listScroll.scrollHeight}/${listScroll.clientHeight}; timeline: ${timelineCells}; turn rows: ${turnRows}; trace: 判定过程; sticky: 粘性`);
} catch (err: any) {
  failed = true;
  console.error(`FAIL ${err?.message ?? err}`);
} finally {
  await browser?.close();
  window_?.stop(true);
  child.kill();
  await child.exited;
  await reading;
  process.exit(failed ? 1 : 0);
}
