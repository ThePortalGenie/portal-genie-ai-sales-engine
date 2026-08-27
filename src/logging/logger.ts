export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|grant/i;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(nested);
    }
    return output;
  }
  return value;
}

export function createLogger(options: { level?: LogLevel } = {}): Logger {
  const minLevel = options.level ?? "info";
  const rank: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };

  function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (rank[level] < rank[minLevel]) {
      return;
    }
    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(context ? { context: sanitize(context) } : {}),
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stderr.write(`${line}\n`);
    }
  }

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
