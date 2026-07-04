import { Request, Response } from "express";
import { Trace } from "jinaga";
import { Pool } from "pg";

// Liveness ("/health") answers "is the process alive?" and must never depend on
// external services. If it checked PostgreSQL and the database went down, the
// container runtime would restart an otherwise-healthy replicator, turning a
// transient database outage into a crash loop.
//
// Readiness ("/ready") answers "can this replicator serve traffic right now?"
// It stays not-ready until initialization completes, then verifies the
// PostgreSQL connection on each probe. When the database is unreachable the
// orchestrator removes the pod from rotation without restarting it.

let ready = false;
let healthPool: Pool | null = null;

export function initializeHealthCheck(connectionString: string): void {
  // A dedicated, minimal pool keeps readiness probes independent of the main
  // fact-store connection pool and bounds the work each probe can do.
  healthPool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 3000,
  });
  healthPool.on('error', (err: Error) => {
    Trace.warn(`Health check pool error: ${err.message}`);
  });
}

export function setReady(value: boolean): void {
  ready = value;
}

export function livenessHandler(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok" });
}

export async function readinessHandler(_req: Request, res: Response): Promise<void> {
  if (!ready || !healthPool) {
    res.status(503).json({ status: "not ready", reason: "initializing" });
    return;
  }
  try {
    await healthPool.query("SELECT 1");
    res.status(200).json({ status: "ready" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Trace.warn(`Readiness check failed: ${message}`);
    res.status(503).json({ status: "not ready", reason: "database unavailable" });
  }
}

export async function shutdownHealthCheck(): Promise<void> {
  ready = false;
  if (healthPool) {
    const pool = healthPool;
    healthPool = null;
    await pool.end();
  }
}
