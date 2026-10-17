import { TraceLevel } from "jinaga";

// Every level jinaga's Trace accepts. Typing this as a Record over TraceLevel
// means a level that jinaga adds or removes fails the build until this list
// follows, rather than leaving a second hand-written list to drift.
const traceLevels: Record<TraceLevel, true> = {
  debug: true,
  info: true,
  warn: true,
  error: true
};

export const acceptedLogLevels = Object.keys(traceLevels) as TraceLevel[];

const defaultLogLevel: TraceLevel = "info";

// Reads the trace threshold from LOG_LEVEL. Unset or empty means the default,
// because a container that declares the variable without a value supplies an
// empty string. Any other value is refused rather than guessed at, so the
// replicator never serves at a level nobody chose.
export function readLogLevel(value: string | undefined = process.env.LOG_LEVEL): TraceLevel {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return defaultLogLevel;
  }
  if (Object.prototype.hasOwnProperty.call(traceLevels, trimmed)) {
    return trimmed as TraceLevel;
  }
  throw new Error(`The environment variable LOG_LEVEL is set to ${JSON.stringify(value)}, which is not one of the accepted values: ${acceptedLogLevels.join(", ")}.`);
}
