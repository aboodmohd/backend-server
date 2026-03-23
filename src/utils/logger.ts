type Meta = Record<string, unknown> | undefined;

function log(level: 'info' | 'warn' | 'error', message: string, meta?: Meta): void {
  const prefix = `${new Date().toISOString()} [${level}] ${message}`;
  if (meta && Object.keys(meta).length > 0) {
    console[level](prefix, meta);
    return;
  }

  console[level](prefix);
}

export const logger = {
  info(message: string, meta?: Meta): void {
    log('info', message, meta);
  },
  warn(message: string, meta?: Meta): void {
    log('warn', message, meta);
  },
  error(message: string, meta?: Meta): void {
    log('error', message, meta);
  },
};
