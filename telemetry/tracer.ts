import { ConsoleTracer, Trace } from "jinaga";
import { OpenTelemetryTracer } from "./trace";

export function startTracer() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    console.log('OTEL_EXPORTER_OTLP_ENDPOINT is not set. Logs will appear in the console.');
    Trace.configure(new ConsoleTracer());
  }
  else {
    Trace.configure(new OpenTelemetryTracer());
    console.log('Tracing started');
  }
}
