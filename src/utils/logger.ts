// utils/logger.ts

import pino from 'pino';

const level = (process.env.LOG_LEVEL || 'info') as pino.Level;
const pretty = process.env.NODE_ENV !== 'production';

// Redact common sensitive fields and long tokens from logs to avoid accidental leakage.
const redact = {
  paths: ['req.headers.authorization', 'res.headers.authorization', 'err.stack'],
  censor: '[REDACTED]',
};

const baseOptions: pino.LoggerOptions = {
  level,
  redact,
};

const pinoFactory: any = pino;
const logger = pinoFactory(
  pretty
    ? {
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : baseOptions
);

export default logger;
