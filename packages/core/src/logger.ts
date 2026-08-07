import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    // The deposit master seed must never reach a log line, even by accident.
    redact: { paths: ["seed", "masterSeed", "DEPOSIT_MASTER_SEED"], censor: "[redacted]" }
  });
}
