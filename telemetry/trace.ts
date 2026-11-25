import { Attributes, context, Counter, Gauge, Histogram, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
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
  private gauges: { [key: string]: Gauge<Attributes> } = {};

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

  // Each measurement is recorded on a gauge named for its key, created once and
  // reused, with the message as an attribute. Creating an instrument per call,
  // as this once did, registered a new observable gauge every time: callers
  // such as jinaga-server's feed usage (every 10 seconds per active feed) and
  // distribution.unmatched (per request) made the registrations, and their
  // callbacks, grow for the life of the process, and the message saying what
  // was measured was dropped.
  metric(message: string, measurements: { [key: string]: number }): void {
    const attributes = metricAttributes(message);
    Object.entries(measurements).forEach(([key, value]) => {
      let gauge = this.gauges[key];
      if (!gauge) {
        gauge = this.meter.createGauge(key);
        this.gauges[key] = gauge;
      }
      gauge.record(value, attributes);
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

  debug(message: string): void {
    this.logger.emit({
      body: message,
      severityText: 'DEBUG',
    });
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

// jinaga-server reports feed usage as "Feed usage <shapeKey> <instanceKey>".
// Splitting the keys out lets a dashboard group by feed shape, or pick out one
// instance, rather than match on a composite string. Any other message is
// carried whole.
const feedUsagePrefix = "Feed usage ";

export function metricAttributes(message: string): Attributes {
  if (message.startsWith(feedUsagePrefix)) {
    const [shape, instance] = message.slice(feedUsagePrefix.length).split(" ");
    if (shape && instance) {
      return { message: "Feed usage", shape, instance };
    }
  }
  return { message };
}
