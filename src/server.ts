import { readConfig, classifierSupport, type Group } from "./rules";
import { readHistory, type Filters } from "./history";
import { replay } from "./replay";
import { JevClient } from "./jev";
import { planApply } from "./apply";

export interface ServiceOptions {
  port?: number;
  magpieBin?: string;
  retry?: boolean;
  log?: boolean;
  addr?: string;
  dir?: string;
  jev?: JevClient;
}
export interface RunningService {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  jev: JevClient;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8" },
});
const failure = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

function draftFor(group: Group, draft: any): Group {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("draft 必须是对象");
  if (!Array.isArray(draft.rules)) throw new Error("draft.rules 必须是数组");
  for (const rule of draft.rules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("draft.rules 的每条规则必须是对象");
    if (typeof rule.use !== "string" || !rule.use) throw new Error("每条规则必须有 use");
  }
  const intentSure = draft.intentSure === undefined ? group.intentSure : draft.intentSure;
  if (intentSure != null && (typeof intentSure !== "number" || !Number.isFinite(intentSure) || intentSure < 0 || intentSure > 1)) {
    throw new Error("draft.intentSure 必须在 0…1");
  }
  return { ...group, rules: structuredClone(draft.rules), intentSure };
}

export function resolveMagpieBin(options: ServiceOptions = {}): string {
  if (options.magpieBin) return options.magpieBin;
  const found = Bun.which("magpie");
  return found || "/Applications/magpie.app/Contents/MacOS/magpie";
}

const page = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Intent Lab</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1d1d1b; --muted: #666; --line: #d8d8d2; }
  @media (prefers-color-scheme: dark) { :root { --bg: #191918; --fg: #ececea; --muted: #a3a39d; --line: #3a3a37; } }
  body { margin: 0; padding: 2rem; background: var(--bg); color: var(--fg); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.45rem; margin: 0 0 .35rem; }
  p { color: var(--muted); margin: 0 0 1.2rem; }
  ul { padding: 0; list-style: none; border-top: 1px solid var(--line); }
  li { border-bottom: 1px solid var(--line); padding: .55rem 0; }
  a { color: inherit; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Intent Lab</h1>
  <p>阶段 A 服务已启动。完整界面在阶段 B。</p>
  <ul>
    <li><a href="/api/groups"><code>GET /api/groups</code></a> 带 intent 规则的组与分类器支持状态</li>
    <li><a href="/api/samples?limit=30"><code>GET /api/samples?limit=30</code></a> 历史样本与关联统计</li>
    <li><code>POST /api/run</code> SSE 回测</li>
    <li><code>POST /api/apply</code> dryRun 命令预览</li>
  </ul>
</main>
</body>
</html>`;

function sse(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, event: string, data: unknown) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function makeFetch(jev: JevClient, magpieBin: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (request.method === "GET" && url.pathname === "/api/groups") {
        const config = await readConfig();
        const groups = config.groups
          .filter(g => (g.rules ?? []).some(r => r.intent))
          .map(g => {
            const support = classifierSupport(g.classifier, config.providers, config.modelAPIs);
            return { ...g, intentSure: g.intentSure ?? null, supported: support.supported, reason: support.reason ?? null };
          });
        return json({ groups });
      }
      if (request.method === "GET" && url.pathname === "/api/samples") {
        const filters: Filters = {
          agents: url.searchParams.get("agents") ?? undefined,
          from: url.searchParams.get("from") ?? undefined,
          to: url.searchParams.get("to") ?? undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        };
        return json(await readHistory(filters));
      }
      if (request.method === "POST" && url.pathname === "/api/run") {
        let body: any;
        try { body = await request.json(); } catch { return failure(400, "请求体不是 JSON"); }
        let group: Group | undefined, draft: Group;
        try {
          const config = await readConfig();
          group = config.groups.find(g => g.id === body?.group);
          if (!group) return failure(400, `未知组 ${body?.group}`);
          const support = classifierSupport(group.classifier, config.providers, config.modelAPIs);
          if (!support.supported) return failure(400, support.reason ?? "分类器不支持");
          draft = draftFor(group, body?.draft);
        } catch (err: any) {
          return failure(400, err.message ?? String(err));
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            (async () => {
              try {
                sse(controller, encoder, "progress", { done: 0, total: 0, phase: "history" });
                const history = await readHistory({
                  agents: body?.agents, from: body?.from, to: body?.to, limit: body?.limit,
                });
                if (!history.samples.length) throw new Error("没有符合条件的样本");
                sse(controller, encoder, "progress", { done: 0, total: history.samples.length, phase: "replay" });
                const result = await replay(jev, group!, group!, draft, history.samples, (done, total) => {
                  sse(controller, encoder, "progress", { done, total, phase: "replay" });
                });
                sse(controller, encoder, "result", { ...result, stats: history.stats, cache: { ...jev.stats } });
                controller.close();
              } catch (err: any) {
                try { sse(controller, encoder, "error", { error: err?.message ?? String(err) }); } catch { /* stream already closed */ }
                try { controller.close(); } catch { /* stream already closed */ }
              }
            })();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/api/apply") {
        let body: any;
        try { body = await request.json(); } catch { return failure(400, "请求体不是 JSON"); }
        // Phase A never executes. The release boundary is checked before
        // reading the draft or the real configuration.
        if (body?.dryRun !== true) return failure(501, "阶段 A 只支持 dryRun=true");
        const config = await readConfig();
        const group = config.groups.find(g => g.id === body?.group);
        if (!group) return failure(400, `未知组 ${body?.group}`);
        let draft: Group;
        try { draft = draftFor(group, body?.draft); } catch (err: any) { return failure(400, err.message ?? String(err)); }
        const plan = planApply(group, draft, magpieBin);
        return json(plan, plan.error && plan.commands.length === 0 ? 400 : 200);
      }
      return failure(404, "not found");
    } catch (err: any) {
      return failure(500, err?.message ?? String(err));
    }
  };
}

export async function startService(options: ServiceOptions = {}): Promise<RunningService> {
  const jev = options.jev ?? new JevClient({ addr: options.addr, dir: options.dir });
  const requested = Number.isInteger(options.port) && options.port! >= 0 ? options.port! : 3488;
  const bin = resolveMagpieBin(options);
  for (;;) {
    try {
      const server = Bun.serve({ hostname: "127.0.0.1", port: requested, idleTimeout: 255, fetch: makeFetch(jev, bin) });
      const port = server.port ?? requested;
      if (options.log !== false) console.log(`intent-lab listening http://127.0.0.1:${port}`);
      return { server, port, jev };
    } catch (err) {
      if (!options.retry) throw err;
      await Bun.sleep(200);
    }
  }
}

if (import.meta.main) {
  const raw = process.env.INTENT_LAB_PORT;
  const port = raw === undefined ? 3488 : Number(raw);
  await startService({ port: Number.isInteger(port) && port >= 0 ? port : 3488, log: true });
}
