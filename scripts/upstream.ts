// Records the upstream checkout the port was compared with. C1 shows this
// commit so a difference from the locally installed magpie is visible.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = process.env.MAGPIE_SOURCE ?? "/tmp/magpie-latest";
const proc = Bun.spawnSync(["git", "-C", source, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "pipe" });
if (proc.exitCode !== 0) throw new Error(`git rev-parse failed in ${source}: ${new TextDecoder().decode(proc.stderr)}`);
const commit = new TextDecoder().decode(proc.stdout).trim();
if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`unexpected commit: ${commit}`);
await mkdir(join(root, "src"), { recursive: true });
await writeFile(join(root, "src/upstream.json"), JSON.stringify({ commit }, null, 2) + "\n");
console.log(`upstream: ${commit} (${source})`);
