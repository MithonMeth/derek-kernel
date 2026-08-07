import { fileURLToPath } from "node:url";
import { Runtime, createLogger, loadConfig } from "@derek/core";

const log = createLogger("derek-worker");
const cfg = loadConfig();

const constitutionDir = fileURLToPath(new URL("../../../constitution", import.meta.url));

let runtime: Runtime;
try {
  runtime = await Runtime.create(cfg, constitutionDir, log);
} catch (e) {
  log.fatal({ err: (e as Error).message }, "refusing to start");
  process.exit(1);
}

runtime.start();
log.info(
  {
    paused: await runtime.isPaused(),
    model: runtime.model !== null,
    chain: runtime.chain !== null
  },
  "worker running"
);

// Timers are unref'd; hold the process open explicitly.
setInterval(() => undefined, 1 << 30);
