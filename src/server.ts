import { readConfig, classifierSupport, type Group } from "./rules";
import { readHistory, type Filters } from "./history";
import { replay } from "./replay";
import { JevClient } from "./jev";
import { planApply, type ApplyPlan } from "./apply";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
    if (rule.intent != null && typeof rule.intent !== "string") throw new Error("每条规则的 intent 必须是字符串");
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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const uiDir = join(root, "ui");
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

async function staticResponse(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "index.html" : pathname.startsWith("/ui/") ? pathname.slice(4) : "";
  if (!rel || rel.includes("\0") || rel.split("/").some(part => part === "..")) return null;
  const file = join(uiDir, rel);
  if (!file.startsWith(uiDir + sep)) return null;
  const body = Bun.file(file);
  if (!(await body.exists())) return null;
  return new Response(body, {
    headers: {
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

function magpieEnv(): Record<string, string> {
  const raw = process.env.INTENT_LAB_MAGPIE_ENV;
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("INTENT_LAB_MAGPIE_ENV 不是 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INTENT_LAB_MAGPIE_ENV 必须是 JSON 对象");
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`INTENT_LAB_MAGPIE_ENV.${key} 必须是字符串`);
    out[key] = item;
  }
  return out;
}

interface CommandResult { command: string; code: number; stdout: string; stderr: string }

async function exec(command: string, env: Record<string, string | undefined>): Promise<CommandResult> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { command, code, stdout, stderr };
}

async function executePlan(group: Group, plan: ApplyPlan, bin: string): Promise<Record<string, unknown>> {
  const env = { ...process.env, ...magpieEnv() };
  const executed: CommandResult[] = [];
  for (const command of plan.commands) {
    const result = await exec(command, env);
    executed.push(result);
    if (result.code !== 0) {
      return {
        ...plan, ok: false, executed,
        error: `命令失败（退出码 ${result.code}）${result.stderr.trim() ? ": " + result.stderr.trim() : ""}`,
      };
    }
  }
  let readBack = "", readBackError = "";
  try {
    const proc = Bun.spawn([bin, "group", "rule", group.id], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code === 0) readBack = stdout;
    else readBackError = stderr.trim() || `退出码 ${code}`;
  } catch (err: any) {
    readBackError = err?.message ?? String(err);
  }
  if (readBackError) return { ...plan, ok: false, executed, readBack, error: `读回规则失败: ${readBackError}` };
  return { ...plan, ok: true, executed, readBack };
}

function sse(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, event: string, data: unknown) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function makeFetch(jev: JevClient, magpieBin: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/ui/"))) {
        return (await staticResponse(url.pathname)) ?? failure(404, "not found");
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
        const config = await readConfig();
        const group = config.groups.find(g => g.id === body?.group);
        if (!group) return failure(400, `未知组 ${body?.group}`);
        let draft: Group;
        try { draft = draftFor(group, body?.draft); } catch (err: any) { return failure(400, err.message ?? String(err)); }
        const plan = planApply(group, draft, magpieBin);
        if (body?.dryRun !== false) {
          return json({ ...plan, ok: !plan.error, executed: [] }, plan.error && plan.commands.length === 0 ? 400 : 200);
        }
        // Only an explicit dryRun=false executes. A plan with no lossless
        // commands never reaches the CLI.
        if (plan.error) return json({ ...plan, ok: false, executed: [] }, 400);
        if (!plan.commands.length && plan.rejected.length) {
          return json({ ...plan, ok: false, executed: [], error: "草稿里有无法无损写回的规则" }, 400);
        }
        if (!plan.commands.length) return json({ ...plan, ok: true, executed: [] });
        try {
          return json(await executePlan(group, plan, magpieBin));
        } catch (err: any) {
          return failure(400, err?.message ?? String(err));
        }
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
