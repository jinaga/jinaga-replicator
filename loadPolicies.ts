import { Dirent, readFile, readdir } from "fs";
import { RuleSet } from "jinaga";
import { join } from "path";

const MARKER_FILE_NAME = "no-security-policies";

export async function loadPolicies(path: string): Promise<RuleSet | undefined> {
    const { policyFiles, hasMarkerFile } = await findPolicyFiles(path);

    if (hasMarkerFile && policyFiles.length > 0) {
        throw new Error(`Security policies are disabled, but there are policy files in ${path}.`);
    }

    if (!hasMarkerFile && policyFiles.length === 0) {
        throw new Error(`No security policies found in ${path}.`);
    }

    if (policyFiles.length === 0) {
        // Leave the replicator wide open
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

    const entries = await new Promise<Dirent[]>((resolve, reject) => {
        readdir(dir, { withFileTypes: true }, (err, files) => {
            if (err) {
                reject(err);
            } else {
                resolve(files);
            }
        });
    });

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
    const description = await new Promise<string>((resolve, reject) => {
        readFile(path, 'utf8', (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });

    const ruleSet = RuleSet.loadFromDescription(description);
    return ruleSet;
}