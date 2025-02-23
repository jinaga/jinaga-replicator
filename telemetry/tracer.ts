import { Trace } from "jinaga";
import { OpenTelemetryTracer } from "./trace";

export function startTracer() {
  Trace.configure(new OpenTelemetryTracer());
  console.log('Tracing started');
}
