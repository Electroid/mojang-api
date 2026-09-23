/**
 * Parser v1 re-exported under the old name so call sites and tests keep working.
 * Interpretation lives in parse.ts — not in the proxy.
 */
export {
  PARSER,
  classifyArgs as classify,
  isAbsentStatus,
  missingPhrase,
  isTerminal,
  shouldRotate,
  clientSawMiss,
  publicErrorStatus,
  identity,
  session,
  limitOf,
} from "./parse";
