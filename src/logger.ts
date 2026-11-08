// Structured logger (pino). Level is controlled by LOG_LEVEL.
import pino from 'pino';

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
