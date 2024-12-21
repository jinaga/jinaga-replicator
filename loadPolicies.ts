import { Dirent, readFile, readdir } from "fs";
import { RuleSet } from "jinaga";
import { join } from "path";

export async function loadPolicies(path: string): Promise<RuleSet | undefined> {
    const fileNames = await findPolicyFiles(path);
    if (fileNames.length === 0) {
        // Leave the replicator wide open
        return undefined;
    }

    let ruleSet = RuleSet.empty;

    for (const fileName of fileNames) {
        const rules = await loadRuleSetFromFile(fileName);
        ruleSet = ruleSet.merge(rules);
    }

    return ruleSet;
}

async function findPolicyFiles(dir: string): Promise<string[]> {
    const fileNames: string[] = [];

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
            await findPolicyFiles(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.policy')) {
            fileNames.push(fullPath);
        }
    }

    return fileNames;
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