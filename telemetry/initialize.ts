const { trace }  = require("@opentelemetry/api");
const { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor }  = require("@opentelemetry/sdk-trace-base");

const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { NodeSDK } = require('@opentelemetry/sdk-node');

let sdk: any;

// Create and register an SDK
const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (!OTEL_EXPORTER_OTLP_ENDPOINT) {
  console.log('OTEL_EXPORTER_OTLP_ENDPOINT is not set. Tracing will not be enabled.');
}
else {
    const provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    trace.setGlobalTracerProvider(provider);
    const traceExporter = new OTLPTraceExporter({
        url: OTEL_EXPORTER_OTLP_ENDPOINT,
    });
    sdk = new NodeSDK({
        traceExporter,
        instrumentations: [getNodeAutoInstrumentations()],
    });

    sdk.start();
}

export default async function shutdownTracer() {
    if (!sdk) {
        return Promise.resolve();
    }
    return sdk.shutdown()
        .then(() => console.log('Tracing terminated'))
        .catch((error: any) => console.log('Error terminating tracing', error));
}
