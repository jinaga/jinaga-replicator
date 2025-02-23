import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

let sdk: NodeSDK | undefined;

const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME;
if (!OTEL_EXPORTER_OTLP_ENDPOINT) {
    console.log('OTEL_EXPORTER_OTLP_ENDPOINT is not set. Tracing will not be enabled.');
}
else {
    // Create and register an SDK
    const traceExporter = new OTLPTraceExporter({
        url: OTEL_EXPORTER_OTLP_ENDPOINT
    });
    const loggerExporter = new OTLPLogExporter({
        url: OTEL_EXPORTER_OTLP_ENDPOINT
    });
    const metricExporter = new OTLPMetricExporter({
        url: OTEL_EXPORTER_OTLP_ENDPOINT
    });
    const logRecordProcessor = new BatchLogRecordProcessor(loggerExporter);
    const metricReader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60000
    });

    sdk = new NodeSDK({
        traceExporter,
        instrumentations: [getNodeAutoInstrumentations()],
        resource: new Resource({
            [ATTR_SERVICE_NAME]: OTEL_SERVICE_NAME || 'jinaga-replicator',
        }),
        logRecordProcessors: [logRecordProcessor],
        metricReader: metricReader
    });

    sdk.start();
}

export default async function shutdownTelemetry() {
    if (!sdk) {
        return Promise.resolve();
    }
    return sdk.shutdown()
        .then(() => console.log('Tracing terminated'))
        .catch((error: any) => console.log('Error terminating tracing', error));
}
