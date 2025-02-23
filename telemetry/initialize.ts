const { trace, metrics } = require("@opentelemetry/api");
const { BasicTracerProvider, SimpleSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { MeterProvider } = require('@opentelemetry/sdk-metrics');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { NodeSDK } = require('@opentelemetry/sdk-node');

let sdk: any;

// Create and register an SDK
const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME;
if (!OTEL_EXPORTER_OTLP_ENDPOINT) {
    console.log('OTEL_EXPORTER_OTLP_ENDPOINT is not set. Tracing will not be enabled.');
}
else {
    const tracerProvider = new BasicTracerProvider();
    const traceExporter = new OTLPTraceExporter({
        url: OTEL_EXPORTER_OTLP_ENDPOINT,
        resource: new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: OTEL_SERVICE_NAME || 'jinaga-replicator',
        })
    });
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(traceExporter));
    trace.setGlobalTracerProvider(tracerProvider);

    const metricsExporter = new OTLPTraceExporter({
        url: OTEL_EXPORTER_OTLP_ENDPOINT,
        resource: new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: OTEL_SERVICE_NAME || 'jinaga-replicator',
        })
    });
    const metricsProvider = new MeterProvider({
        exporter: metricsExporter
    });
    metrics.setGlobalMeterProvider(metricsProvider);

    sdk = new NodeSDK({
        traceExporter,
        instrumentations: [getNodeAutoInstrumentations()],
        resource: new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: OTEL_SERVICE_NAME || 'jinaga-replicator',
        })
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
