import { readdir, stat } from "fs/promises";
import { Trace } from "jinaga";
import { join } from "path";
import { MARKER_FILE_NAME } from "./loadPolicies";

// A cheap fingerprint of the policy directory: the set of relevant files paired
// with their size and modification time. A content edit (mtime bump), an added
// file, and a removed file each change the fingerprint.
//
// Unlike an inotify-based watcher, this relies only on stat, which reflects the
// real state of the underlying file even when the directory is a network mount
// (SMB/NFS, e.g. Azure Files) where filesystem-change events are not delivered.
async function computeSignature(dir: string): Promise<string> {
    const parts: string[] = [];
    await collect(dir, parts);
    parts.sort();
    return parts.join('|');
}

async function collect(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch (error) {
        // The directory does not exist (yet); treat as empty.
        return;
    }

    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            await collect(fullPath, out);
        }
        else if (entry.isFile() && (entry.name.endsWith('.policy') || entry.name === MARKER_FILE_NAME)) {
            try {
                const stats = await stat(fullPath);
                out.push(`${fullPath}:${stats.size}:${stats.mtimeMs}`);
            }
            catch (error) {
                // The file vanished between readdir and stat; ignore it.
            }
        }
    }
}

export interface PolicyReloaderOptions {
    // Directory of .policy files to watch for changes.
    path: string;
    // Invoked (in the background) when the directory fingerprint changes. Must
    // not throw — it is expected to handle its own errors (e.g. keep the current
    // rules on a parse failure).
    onChange: () => Promise<void>;
}

// Build a cheap, non-blocking checkForChanges() to call on each request. It
// fingerprints the policy directory in the background and invokes onChange when
// the fingerprint differs from the last observed one.
//
// This lazy stat-on-read strategy adds no background poll loop while the
// replicator is idle, is correct across independently-scaling replicas with no
// coordination, and is scale-to-zero friendly: a woken replica loads fresh
// rules at boot, and a running replica re-checks on the next request. The
// baseline is established eagerly so it matches the rules already loaded at boot.
export async function createPolicyReloader({ path, onChange }: PolicyReloaderOptions): Promise<() => void> {
    let lastSignature = await computeSignature(path);
    let checking = false;

    return function checkForChanges() {
        // Only one check runs at a time; concurrent requests are no-ops and the
        // in-flight check already reflects the latest on-disk state.
        if (checking) {
            return;
        }
        checking = true;
        computeSignature(path)
            .then(async signature => {
                if (signature === lastSignature) {
                    return;
                }
                // Record the new state up front so a burst of requests triggers
                // only one reload per distinct file state — even if the reload
                // (or its parse) fails, in which case the current rules are kept
                // and the next genuine edit (a fresh mtime) triggers a retry.
                lastSignature = signature;
                Trace.info('Detected a change to the security policies.');
                await onChange();
            })
            .catch(error => {
                Trace.warn(`Error checking for policy changes: ${error instanceof Error ? error.message : String(error)}`);
            })
            .finally(() => {
                checking = false;
            });
    };
}
