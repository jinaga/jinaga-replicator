import * as chardet from "chardet";
import { Dirent } from "fs";
import { readdir, readFile } from "fs/promises";
import * as iconv from "iconv-lite";
import { Declaration, FactManager, FactReference, Specification, SpecificationParser, Trace } from "jinaga";
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

export function runSubscriptions(subscriptions: Subscription[], factManager: FactManager) {
    for (const subscription of subscriptions) {
        runSubscription(subscription, factManager);
    }
}

function runSubscription(subscription: Subscription, factManager: FactManager) {
    const observer = factManager.startObserver(subscription.start, subscription.specification, _ => { }, true);
    observer.loaded().catch(error => {
        Trace.error(`Error running subscription: ${error}`);
    });
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
