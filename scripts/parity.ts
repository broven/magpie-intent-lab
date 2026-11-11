import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantSaid, cutMiddle, lastSaid, turnBefore, userSaid, userText } from "../src/textprep";
import { intentOf, jevBody, levelsOf, readJev } from "../src/jev";
import { Intents, MatchRule, Matches } from "../src/rules";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const results: Record<string, any> = {};
for (const name of (await readdir(join(root, "fixtures"))).filter(n => n.endsWith(".json")).sort()) {
  const f = JSON.parse(await readFile(join(root, "fixtures", name), "utf8"));
  const messages = f.messages;
  const last = lastSaid(messages, messages.length);
  const q = Object.fromEntries(Object.entries(f.query ?? {}).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v]));
  q.time = q.at;
  const result: any = {
    userSaid: messages.map(userSaid), lastSaid: last,
    cutMiddle: cutMiddle(last.text, 3000, 1000), turnBefore: turnBefore(messages),
    jevBody: jevBody(f.model, f.intents, f.work ?? null, f.prev ?? {}, !!f.effort, userText(messages)),
    levelsOf: levelsOf(f.intents, f.scores ?? []),
    matches: (f.rules ?? []).map((r: any) => Matches(r, q)),
    intents: Intents(f.rules ?? [], q), matchRule: MatchRule(f.rules ?? [], q),
  };
  if (f.answer) {
    const v = readJev(f.answer, f.intents, !!f.levels, f.prev ?? {});
    result.verdict = v;
    result.intentOf = intentOf(v, { intentSure: f.intentSure });
  }
  results[name] = result;
}
const tsFile = process.argv[3];
if (tsFile) await writeFile(tsFile, canonical(results));
const expected = JSON.parse(await readFile(process.argv[2], "utf8"));
let count = 0;
for (const name of Object.keys(results)) {
  if (canonical(results[name]) !== canonical(expected[name])) {
    for (const key of Object.keys(results[name])) {
      if (canonical(results[name][key]) !== canonical(expected[name]?.[key])) console.error(`DIFF ${name}: ${key}`);
    }
    process.exitCode = 1;
  } else count++;
}
if (process.exitCode) throw new Error(`parity mismatch (${count}/${Object.keys(results).length})`);
console.log(`parity: ${count}/${Object.keys(results).length} identical`);
