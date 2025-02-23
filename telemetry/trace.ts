import { Attributes, context, SpanStatusCode, trace } from '@opentelemetry/api';
import { metrics, MetricOptions, ObservableResult, Counter } from '@opentelemetry/api-metrics';
import { logs } from '@opentelemetry/api-logs';
import { Tracer } from "jinaga/dist/util/trace";
import { NodeTracerProvider, TracerConfig } from '@opentelemetry/sdk-trace-node';

// Configure the exporter
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
const exporter = new OTLPTraceExporter();
trace.setGlobalTracerProvider(new NodeTracerProvider({
  exporter,
} as TracerConfig));

export class OpenTelemetryTracer implements Tracer {
  private tracer = trace.getTracer('default');
  private meter = metrics.getMeter('default');
  private logger = logs.getLogger('default');
  private counterAccumulation: { [key: string]: number } = {};
  private counterTimeout: NodeJS.Timeout | null = null;
  private counters: { [key: string]: Counter<Attributes> } = {};

  async dependency<T>(name: string, data: string, operation: () => Promise<T>): Promise<T> {
    const span = this.tracer.startSpan(name, {
      attributes: { data },
    });
    try {
      return await context.with(trace.setSpan(context.active(), span), operation);
    } catch (error) {
      if (error instanceof Error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      }
      throw error;
    } finally {
      span.end();
    }
  }

  metric(message: string, measurements: { [key: string]: number }): void {
    Object.entries(measurements).forEach(([key, value]) => {
      this.meter.createObservableGauge(key, {
        callback: async (observableResult: ObservableResult) => {
          observableResult.observe(value);
        },
      } as MetricOptions);
    });
  }

  counter(name: string, value: number): void {
    if (!this.counters[name]) {
      this.counters[name] = this.meter.createCounter(name);
    }
    const counter = this.counters[name];
    counter.add(value);

    if (this.counterTimeout) {
      this.counterAccumulation[name] = (this.counterAccumulation[name] || 0) + value;
    } else {
      this.counterAccumulation[name] = value;
      this.counterTimeout = setTimeout(() => {
        for (const [counterName, counterValue] of Object.entries(this.counterAccumulation)) {
          console.info(`COUNTER: ${counterName} incremented by ${counterValue}`);
        }
        this.counterAccumulation = {};
        this.counterTimeout = null;
      }, 1000);
    }
  }

  info(message: string): void {
    this.logger.emit({
      body: message,
      severityText: 'INFO',
    });
  }

  warn(message: string): void {
    this.logger.emit({
      body: message,
      severityText: 'WARN',
    });
  }

  error(error: Error): void {
    this.logger.emit({
      body: error.message,
      severityText: 'ERROR',
      attributes: { stack: error.stack },
    });
  }
}
