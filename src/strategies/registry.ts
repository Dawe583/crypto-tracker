// Strategy registry: merge library defaults with data/strategies.json overrides.
// JSON is the mandate (ai-hedge-fund style): enable/disable/tune without code edits.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { LIBRARY } from './library.js';
import type { Strategy } from '../engine/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const CONF_PATH = join(here, '..', '..', 'data', 'strategies.json');

export interface ActiveStrategy { strategy: Strategy; params: Record<string, number>; enabled: boolean }
type StrategyConfig = Record<string, { enabled?: boolean; params?: Record<string, number> }>;

export function loadStrategies(overrides?: StrategyConfig): ActiveStrategy[] {
  let conf: StrategyConfig = overrides ?? {};
  if (!overrides && existsSync(CONF_PATH)) {
    try { conf = JSON.parse(readFileSync(CONF_PATH, 'utf8')); } catch (e) { logger.warn({ err: String(e) }, 'strategies.json parse failed'); }
  }
  return LIBRARY.map((s) => {
    const c = conf[s.name] ?? {};
    return { strategy: s, params: { ...s.defaults, ...(c.params ?? {}) }, enabled: c.enabled !== false };
  });
}
