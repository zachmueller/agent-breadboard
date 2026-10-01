import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level = 'info', pretty = true): Logger {
  if (pretty && process.env.NODE_ENV !== 'production') {
    return pino({ level, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } });
  }
  return pino({ level });
}

export const silentLogger: Logger = pino({ level: 'silent' });
