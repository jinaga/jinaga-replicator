import { metrics } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { ConsoleTracer, Trace } from "jinaga";

let sdk: NodeSDK | undefined;

const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME;

// Set up telemetry if endpoint is configured
if (OTEL_EXPORTER_OTLP_ENDPOINT) {
    const traceExporter = new OTLPTraceExporter({
        url: OTEL_EXPORTER_OTLP_ENDPOINT
    });
    const loggerExporter = new OTLPLogExporter({
        url: OTEL_EXPORTER_OTLP_ENDPOINT
    });
    const logRecordProcessor = new BatchLogRecordProcessor(loggerExporter);
    const metricExporter = new OTLPMetricExporter({
        url: OTEL_EXPORTER_OTLP_ENDPOINT
    });
    const meterProvider = new MeterProvider({
        resource: new Resource({
            [ATTR_SERVICE_NAME]: OTEL_SERVICE_NAME || 'jinaga-replicator',
        }),
        readers: [new PeriodicExportingMetricReader({
            exporter: metricExporter,
            exportIntervalMillis: 1000 // Export metrics every second
        })]
    });
    metrics.setGlobalMeterProvider(meterProvider);

    sdk = new NodeSDK({
        traceExporter,
        instrumentations: [getNodeAutoInstrumentations()],
        resource: new Resource({
            [ATTR_SERVICE_NAME]: OTEL_SERVICE_NAME || 'jinaga-replicator',
        }),
        logRecordProcessors: [logRecordProcessor]
    });

    sdk.start();
    console.log('Tracing enabled');
}

export default async function shutdownTelemetry() {
    if (!sdk) {
        return Promise.resolve();
    }
    return sdk.shutdown()
        .then(() => console.log('Tracing terminated'))
        .catch((error: any) => console.log('Error terminating tracing', error));
}
