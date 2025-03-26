import { Attributes, context, Counter, Histogram, MetricOptions, metrics, ObservableResult, SpanStatusCode, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeTracerProvider, TracerConfig } from '@opentelemetry/sdk-trace-node';
import { Tracer } from "jinaga/dist/util/trace";

// Configure the exporter
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
  private histograms: { [key: string]: Histogram<Attributes> } = {};

  async dependency<T>(name: string, data: string, operation: () => Promise<T>): Promise<T> {
    let histogram: Histogram<Attributes>;
    let success = false;
    if (!this.histograms[name]) {
      histogram = this.meter.createHistogram(`${name}_duration`, {
        description: `Histogram for ${name}`,
        unit: 'ms',
      });
      this.histograms[name] = histogram;
    } else {
      histogram = this.histograms[name];
    }
    const startTime = process.hrtime();
    const span = this.tracer.startSpan(name, {
      attributes: { data },
    });
    try {
      const result = await context.with(trace.setSpan(context.active(), span), operation);
      success = true;
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      if (error instanceof Error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      }
      throw error;
    } finally {
      span.end();
      const [seconds, nanoseconds] = process.hrtime(startTime);
      const duration = seconds * 1000 + nanoseconds / 1e6;
      histogram.record(duration, {
        data,
        success,
      });
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
