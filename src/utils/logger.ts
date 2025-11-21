export const logger = {
  debug: (msg: string, meta?: Record<string, any>) => {
    // Only log debug messages if DEBUG env var is set, to reduce noise in dev
    if (process.env.DEBUG || process.env.PCE_LOG_LEVEL === "DEBUG") {
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
      console.debug(`[debug] ${msg}${metaStr}`);
    }
  },
  info: (msg: string, meta?: Record<string, any>) => {
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    console.log(`[info] ${msg}${metaStr}`);
  },
  warn: (msg: string, meta?: Record<string, any>) => {
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    console.warn(`[warn] ${msg}${metaStr}`);
  },
  error: (msg: string, meta?: Record<string, any>) => {
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    console.error(`[error] ${msg}${metaStr}`);
  },
};

