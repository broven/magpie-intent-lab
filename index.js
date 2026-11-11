// The page's service. It listens on the option port (3488 by default) and
// waits while another program holds it, as internal/plugin/testdata/pageservice
// does. The global guard keeps a second load from starting it again.
import { startService } from "./src/server.ts";

const running = Symbol.for("magpie-intent-lab.service");

export const IntentLab = async (_input, options = {}) => {
  const fromOption = Number(options?.port);
  const fromEnv = Number(process.env.INTENT_LAB_PORT);
  const port = Number.isInteger(fromOption) && fromOption > 0
    ? fromOption
    : Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 3488;
  const old = globalThis[running];
  if (old && old.port === port) return {};
  const service = await startService({
    port,
    magpieBin: typeof options?.magpieBin === "string" ? options.magpieBin : undefined,
    retry: true,
    log: false,
  });
  globalThis[running] = service;
  return {};
};
