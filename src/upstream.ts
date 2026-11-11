import { readFileSync } from "node:fs";
export const upstream = JSON.parse(readFileSync(new URL("./upstream.json", import.meta.url), "utf8")) as {
  commit: string;
  capturedAt?: string;
};
