import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Trace } from "jinaga";
import { OpenTelemetryTracer } from "./trace";

let sdk: NodeSDK | undefined;

export function startTracer(otelExporterOtlpEndpoint: string | undefined) {
  if (!otelExporterOtlpEndpoint) {
    console.log('OTEL_EXPORTER_OTLP_ENDPOINT is not set. Tracing will not be enabled.');
    return;
  }
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

  const traceExporter = new OTLPTraceExporter({
    url: otelExporterOtlpEndpoint,
  });
  sdk = new NodeSDK({
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
  Trace.configure(new OpenTelemetryTracer());
  console.log('Tracing started');
}

export function shutdownTracer() {
  if (!sdk) {
    return Promise.resolve();
  }
  return sdk.shutdown()
    .then(() => console.log('Tracing terminated'))
    .catch((error) => console.log('Error terminating tracing', error));
}
