import * as chokidar from "chokidar";
import { Trace } from "jinaga";
import { basename } from "path";
import { MARKER_FILE_NAME } from "./loadPolicies";

// Only changes to files that affect the loaded rule set should trigger a
// reload: the .policy files themselves and the no-security-policies marker.
// This avoids redundant reload cycles from editor swap files, .DS_Store, etc.
function affectsPolicies(file: string): boolean {
    const name = basename(file);
    return name.endsWith('.policy') || name === MARKER_FILE_NAME;
}

export interface PolicyWatcherOptions {
    // Directory of .policy files to watch (recursively).
    path: string;
    // Quiet period after the last filesystem event before reloading. Editors and
    // atomic-rename writers fire multiple events for a single logical change.
    debounceMs?: number;
    // Invoked after the debounce window settles. Must not throw — it is expected
    // to handle its own errors (e.g. keep the current rules on a parse failure).
    onReload: () => Promise<void>;
}

// Watch a policies directory and invoke onReload on a debounced add/change/unlink
// event. Returns the underlying watcher so the caller can close it on shutdown.
export function watchPolicies({ path, debounceMs = 500, onReload }: PolicyWatcherOptions): chokidar.FSWatcher {
    Trace.info(`Watching for policy changes in ${path}`);

    const watcher = chokidar.watch(path, {
        // The initial set of files is already loaded at boot.
        ignoreInitial: true,
        // Wait for writes to finish before emitting, so a partially-written file
        // is not parsed mid-flight.
        awaitWriteFinish: {
            stabilityThreshold: 200,
            pollInterval: 50
        }
    });

    let timer: NodeJS.Timeout | undefined;
    let reloading = false;
    let pending = false;

    function schedule(event: string, file: string) {
        if (!affectsPolicies(file)) {
            return;
        }
        Trace.info(`Policy file ${event}: ${file}`);
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(trigger, debounceMs);
    }

    async function trigger() {
        timer = undefined;
        // Coalesce events that arrive while a reload is already running.
        if (reloading) {
            pending = true;
            return;
        }
        reloading = true;
        try {
            await onReload();
        }
        catch (error) {
            // onReload owns error handling, but guard against an unexpected throw
            // so a bad reload never takes down the watcher (or the process).
            Trace.warn(`Unexpected error during policy reload: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            reloading = false;
            if (pending) {
                pending = false;
                timer = setTimeout(trigger, debounceMs);
            }
        }
    }

    watcher
        .on('add', file => schedule('added', file))
        .on('change', file => schedule('changed', file))
        .on('unlink', file => schedule('removed', file))
        .on('error', error => Trace.warn(`Policy watcher error: ${error instanceof Error ? error.message : String(error)}`));

    return watcher;
}
