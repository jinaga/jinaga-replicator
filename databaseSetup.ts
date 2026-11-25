import { promises as fs } from "fs";
import { Trace } from "jinaga";

// In the Docker image, start.sh starts PostgreSQL and then applies
// jinaga-server's setup.sql, which upgrades the schema of a data folder written
// by an earlier version. The replicator is started alongside it, so /health and
// /ready answer for the whole of that window, but it must not open the fact
// store until the schema is final: jinaga-server reads the edge-order
// constraint once, on the first feed, and keeps the answer for the life of the
// store.
//
// start.sh names a marker file in JINAGA_DATABASE_SETUP_MARKER and writes it
// once setup has finished, whatever the outcome, with one word saying how it
// went. Outside the image (npm run dev, or a replicator pointed at an external
// database) the variable is unset and there is nothing to wait for.

const pollIntervalMs = 250;

export async function waitForDatabaseSetup(marker: string | undefined = process.env.JINAGA_DATABASE_SETUP_MARKER): Promise<void> {
  if (!marker) {
    return;
  }
  let logged = false;
  while (true) {
    let outcome: string;
    try {
      outcome = (await fs.readFile(marker, "utf8")).trim();
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (!logged) {
        Trace.info("Waiting for the database setup to finish.");
        logged = true;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    if (outcome === "failed") {
      // The schema of an earlier version still serves correctly, so the
      // replicator starts rather than leaving the node down. start.sh has
      // already logged why setup failed.
      Trace.warn("The database setup failed; starting with the schema as it is. See the setup output above.");
    }
    else {
      Trace.info(`Database setup ${outcome}.`);
    }
    return;
  }
}
