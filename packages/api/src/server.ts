import { fileURLToPath } from "node:url";
import { Runtime, createLogger, loadConfig } from "@derek/core";
import { buildApp } from "./app.js";

const log = createLogger("derek-api");
const cfg = loadConfig();
const constitutionDir = fileURLToPath(new URL("../../../constitution", import.meta.url));

let runtime: Runtime;
try {
  runtime = await Runtime.create(cfg, constitutionDir, log);
} catch (e) {
  log.fatal({ err: (e as Error).message }, "refusing to start");
  process.exit(1);
}
if (cfg.EMBED_WORKER) runtime.start();

const app = await buildApp(runtime, cfg);

try {
  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  log.info(
    { port: cfg.PORT, paused: await runtime.isPaused(), embedWorker: cfg.EMBED_WORKER },
    "derek api up"
  );
} catch (e) {
  log.fatal({ err: (e as Error).message }, "listen failed");
  process.exit(1);
}
