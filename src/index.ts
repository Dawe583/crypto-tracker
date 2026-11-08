// Entry point: starts the on-chain listener and the Gold RWA monitor, both feeding the shared alert dispatcher.
import { startListener } from './listener.js';
import { startGoldLoop } from './gold_rwa.js';
import { logger } from './logger.js';

process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandled rejection'));
startListener();
startGoldLoop();
logger.info('Base & EVM whale tracker running (Ctrl+C to stop)');
