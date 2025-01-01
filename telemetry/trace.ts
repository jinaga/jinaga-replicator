import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { Tracer } from "jinaga/dist/util/trace";

export class OpenTelemetryTracer implements Tracer {
  private tracer = trace.getTracer('default');

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
    const span = this.tracer.startSpan(message, {
      attributes: measurements,
    });
    span.end();
  }

  info(message: string): void {
    const span = this.tracer.startSpan('info', {
      attributes: { message },
    });
    span.end();
  }

  warn(message: string): void {
    const span = this.tracer.startSpan('warn', {
      attributes: { message },
    });
    span.end();
  }

  error(error: Error): void {
    const span = this.tracer.startSpan('error');
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
  }
}
