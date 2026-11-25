// OpenTelemetryTracer.metric, driven the way jinaga-server drives it, against
// an in-memory exporter (2 shapes x 5 instances = 10 series): each measurement key must be one instrument, however
// often it is reported, and the feed keys must arrive as attributes.
import { createRequire } from "node:module";
import { check, done } from "./lib.mjs";
const require = createRequire(import.meta.url);
const { metrics } = require("@opentelemetry/api");
const { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } = require("@opentelemetry/sdk-metrics");

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3600000 });
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
const { OpenTelemetryTracer } = require("../../dist/telemetry/trace.js");
const tracer = new OpenTelemetryTracer();

const calls = 2000;
for (let i = 0; i < calls; i++) {
  tracer.metric(`Feed usage shape${i % 2} instance${i % 5}`, { readsInWindow: i, reads: 1 });
  tracer.metric("distribution.unmatched", { "no-rule": 1 });
}
await reader.forceFlush();
const all = exporter.getMetrics().flatMap(r => r.scopeMetrics).flatMap(s => s.metrics);
const names = all.map(m => m.descriptor.name).sort();
check(`${calls * 2} reports make one instrument per measurement key`,
  JSON.stringify(names) === JSON.stringify(["no-rule", "reads", "readsInWindow"]), names.join(", "));
const reads = all.find(m => m.descriptor.name === "readsInWindow");
const points = reads?.dataPoints ?? [];
check("feed usage is split into shape and instance attributes",
  points.length === 10 && points.every(p => p.attributes.message === "Feed usage" && /^shape\d$/.test(p.attributes.shape) && /^instance\d$/.test(p.attributes.instance)),
  `${points.length} series: ${JSON.stringify(points[0]?.attributes)}`);
const last = points.find(p => p.attributes.instance === "instance4" && p.attributes.shape === "shape1");
check("each series reports its latest value", last?.value === calls - 1, `instance4 = ${last?.value}`);
const unmatched = all.find(m => m.descriptor.name === "no-rule")?.dataPoints[0];
check("another message is carried whole", unmatched?.attributes.message === "distribution.unmatched", JSON.stringify(unmatched?.attributes));
done();
