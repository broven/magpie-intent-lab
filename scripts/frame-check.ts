// Loads the plugin the way magpie's window does: page/ in an iframe sandboxed
// to allow-scripts, served under magpie's page policy (pagePolicy in
// internal/gui/pluginpage.go), with a stand-in bridge. Passes only when the
// frame goes on to the service and the interface lists the groups from
// there, with an opaque origin. Catches an inline script the policy blocks
// and a service that refuses Origin "null".
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
  if (logicSteps < 7) throw new Error(`decision-logic panel has ${logicSteps} steps, expected 7`);

  await frame.fill('[data-testid="session-search"]', "git");
  for (const scope of ["user", "reply", "bash"]) await frame.check(`input.scope[value="${scope}"]`);
  let found = false;
  for (const term of ["git", "the"]) {
    if (term !== "git") await frame.fill('[data-testid="session-search"]', term);
    await frame.click('[data-testid="session-search-button"]');
    try {
      await frame.waitForSelector(".session-card", { timeout: 30_000 });
      found = true;
      break;
    } catch { /* try the next common word */ }
  }
  if (!found) throw new Error("session search listed no sessions");
  const sessionCards = await frame.$$eval(".session-card", (nodes: any[]) => nodes.length);
  if (!sessionCards) throw new Error("session search listed no session cards");

  await frame.click('[data-testid="session-preview"]');
  await frame.waitForSelector("#session-modal:not([hidden])", { timeout: 15_000 });
  await frame.waitForSelector("#session-modal .preview-item", { timeout: 30_000 });
  const previewText = await frame.$eval("#session-modal-body", (node: any) => node.textContent ?? "");
  if (!previewText.trim()) throw new Error("session preview modal is empty");
  const previewItems = await frame.$$eval('[data-testid="preview-user"], [data-testid="preview-bash"]', (nodes: any[]) => nodes.length);
  if (!previewItems) throw new Error("session preview has no messages or bash events");
  await page.keyboard.press("Escape");
  await frame.waitForSelector("#session-modal", { state: "hidden", timeout: 5_000 });

  await frame.click("#session-clear");
  await frame.fill('[data-testid="limit-input"]', "5");
  await frame.click('[data-testid="run-button"]');
  await frame.waitForSelector('[data-testid="result-table"] tbody tr.result-row', { timeout: 240_000 });
  await frame.click('[data-testid="result-table"] tbody tr.result-row');
  await frame.waitForSelector("tr.detail", { timeout: 10_000 });
  const detail = await frame.$eval("tr.detail", (node: any) => node.textContent ?? "");
  if (!detail.includes("判定过程")) throw new Error("expanded row has no 判定过程 trace");
  console.log(`PASS frame went to ${frame.url()} (origin ${origin}); groups: ${options.join(", ")}; logic steps: ${logicSteps}; sessions: ${sessionCards}; trace: 判定过程`);
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
