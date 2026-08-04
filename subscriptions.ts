import * as chardet from "chardet";
import { Dirent } from "fs";
import { readdir, readFile } from "fs/promises";
import * as iconv from "iconv-lite";
import { Declaration, FactManager, FactReference, HttpError, Specification, SpecificationParser, Trace } from "jinaga";
import { join } from "path";

export interface Subscription {
    start: FactReference[];
    specification: Specification;
}

export async function loadSubscriptions(path: string): Promise<Subscription[]> {
    const subscriptionFiles = await findSubscriptionFiles(path);
    const subscriptionArrays = await Promise.all(subscriptionFiles.map(loadSubscription));
    return subscriptionArrays.flat();
}

// Start an observer for each subscription against the given fact manager and
// return a disposer that stops them all. The caller is responsible for invoking
// the disposer when the fact manager is retired, otherwise observers accumulate.
export function runSubscriptions(subscriptions: Subscription[], factManager: FactManager): () => void {
    const observers = subscriptions.map(subscription => runSubscription(subscription, factManager));
    return () => {
        for (const observer of observers) {
            observer.stop();
        }
    };
}

// jinaga's web client retries a failed upstream request only when the status can
// succeed on a second attempt: 5xx, 408, and 429. Everything else throws right
// away, so a 401 or a 403 leaves the subscription permanently stalled instead of
// quietly retrying forever.
function isRetryableStatus(statusCode: number): boolean {
    return statusCode >= 500 || statusCode === 408 || statusCode === 429;
}

function runSubscription(subscription: Subscription, factManager: FactManager) {
    const observer = factManager.startObserver(subscription.start, subscription.specification, _ => { }, true);
    observer.loaded().catch(error => {
        // An HttpError carries the upstream's status and its diagnostic body,
        // rather than the bare status line that used to be all that survived.
        // Report which kind of failure this is, because they need different
        // things from an operator: a retryable one clears on its own, while a
        // rejected token or a forbidding distribution rule never will.
        if (error instanceof HttpError && !isRetryableStatus(error.statusCode)) {
            Trace.error(
                `Subscription rejected by the upstream replicator with status ${error.statusCode}: ${error.reason}. ` +
                `This status is not retried, so the subscription will not load until the cause is fixed.`);
        }
        else if (error instanceof HttpError) {
            Trace.warn(`Error running subscription, status ${error.statusCode}: ${error.reason}`);
        }
        else {
            Trace.error(`Error running subscription: ${error}`);
        }
    });
    return observer;
}

async function findSubscriptionFiles(dir: string): Promise<string[]> {
    Trace.info(`Searching for subscription files in ${dir}`);

    const subscriptionFiles: string[] = [];

    let entries: Dirent[] = [];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch (error) {
        // The directory does not exist.
        return subscriptionFiles;
    }

    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            const result = await findSubscriptionFiles(fullPath);
            subscriptionFiles.push(...result);
        } else if (entry.isFile()) {
            if (entry.name.endsWith('.subscription')) {
                subscriptionFiles.push(fullPath);
            }
        }
    }

    return subscriptionFiles;
}

async function loadSubscription(path: string): Promise<Subscription[]> {
    try {
        Trace.info(`Loading subscriptions from ${path}`);

        const buffer = await readFile(path);
        const encoding = (chardet.detect(buffer as any) || 'utf-8').toLowerCase();
        const content = iconv.decode(buffer, encoding);

        return parseSubscriptions(content);
    }
    catch (error) {
        if (error instanceof Error) {
            throw new Error(`Error loading configuration from ${path}: ${error.message}`);
        } else {
            throw new Error(`Error loading configuration from ${path}: ${String(error)}`);
        }
    }
}

function parseSubscriptions(content: string) {
    const subscriptions: Subscription[] = [];

    const parser = new SpecificationParser(content);
    parser.skipWhitespace();

    while (!parser.atEnd()) {
        parser.expect('subscription');
        parser.expect('{');
        let declaration: Declaration = [];
        while (!parser.continues('}')) {
            declaration = parser.parseDeclaration(declaration);
            const specification = parser.parseSpecification();
            const start = specification.given.map(g => {
                const givenDeclaration = declaration.find(d => d.name === g.label.name);
                if (!givenDeclaration) {
                    throw new Error(`Declaration not found for ${g.label.name}`);
                }
                return givenDeclaration.declared.reference;
            });
            subscriptions.push({
                start,
                specification
            });
        }
        parser.expect('}');
    }
    parser.expectEnd();
    return subscriptions;
}
