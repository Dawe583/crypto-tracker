// Entry point: starts the on-chain listener, the Gold RWA monitor, and the JSON API, all in one process.
import { startListener } from './listener.js';
import { startGoldLoop } from './gold_rwa.js';
import { startApi } from './api.js';
import { logger } from './logger.js';

process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandled rejection'));
process.on('SIGTERM', () => { logger.info('SIGTERM received, exiting'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT received, exiting'); process.exit(0); });

startListener();
startGoldLoop();
startApi();
logger.info('Base & EVM whale tracker running (Ctrl+C to stop)');
