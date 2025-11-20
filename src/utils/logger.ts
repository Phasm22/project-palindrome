export const logger = {
  debug: (msg: string) => {
    // Only log debug messages if DEBUG env var is set, to reduce noise in dev
    if (process.env.DEBUG || process.env.PCE_LOG_LEVEL === "DEBUG") {
      console.debug(`[debug] ${msg}`);
    }
  },
  info: (msg: string) => console.log(`[info] ${msg}`),
  warn: (msg: string) => console.warn(`[warn] ${msg}`),
  error: (msg: string) => console.error(`[error] ${msg}`),
};

