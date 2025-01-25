import { readdir, readFile } from "fs/promises";
import * as iconv from "iconv-lite";
import * as chardet from "chardet";
import { RuleSet, Trace } from "jinaga";
import { join } from "path";

const MARKER_FILE_NAME = "no-security-policies";

export async function loadPolicies(path: string): Promise<RuleSet | undefined> {
    Trace.info(`Searching for security policies in ${path}`);

    const { policyFiles, hasMarkerFile } = await findPolicyFiles(path);

    if (hasMarkerFile && policyFiles.length > 0) {
        throw new Error(`Security policies are disabled, but there are policy files in ${path}.`);
    }

    if (!hasMarkerFile && policyFiles.length === 0) {
        throw new Error(`No security policies found in ${path}.`);
    }

    if (hasMarkerFile && policyFiles.length === 0) {
        // Leave the replicator wide open
        Trace.warn(`------- Security policies are disabled!!! -------`);
        return undefined;
    }

    let ruleSet = RuleSet.empty;

    for (const fileName of policyFiles) {
        const rules = await loadRuleSetFromFile(fileName);
        ruleSet = ruleSet.merge(rules);
    }

    return ruleSet;
}

async function findPolicyFiles(dir: string): Promise<{ policyFiles: string[], hasMarkerFile: boolean }> {
    const policyFiles: string[] = [];
    let hasMarkerFile = false;

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            const result = await findPolicyFiles(fullPath);
            policyFiles.push(...result.policyFiles);
            hasMarkerFile = hasMarkerFile || result.hasMarkerFile;
        } else if (entry.isFile()) {
            if (entry.name.endsWith('.policy')) {
                policyFiles.push(fullPath);
            } else if (entry.name === MARKER_FILE_NAME) {
                hasMarkerFile = true;
            }
        }
    }

    return { policyFiles, hasMarkerFile };
}

async function loadRuleSetFromFile(path: string): Promise<RuleSet> {
    try {
        Trace.info(`Loading rule set from ${path}`);

        const buffer = await readFile(path);
        const encoding = chardet.detect(buffer) || 'utf-8';
        const description = iconv.decode(buffer, encoding);
        const ruleSet = RuleSet.loadFromDescription(description);
        return ruleSet;
    }
    catch (error) {
        if (error instanceof Error) {
            throw new Error(`Error loading rule set from ${path}: ${error.message}`);
        } else {
            throw new Error(`Error loading rule set from ${path}: ${String(error)}`);
        }
    }
}