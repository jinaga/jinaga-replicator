import * as chardet from "chardet";
import { NextFunction, Request, Response } from "express";
import { readdir, readFile } from "fs/promises";
import * as iconv from "iconv-lite";
import { Trace } from "jinaga";
import { decode, JwtPayload, verify } from "jsonwebtoken";
import { join } from "path";

interface AuthenticationConfiguration {
    provider: string;
    issuer: string;
    audience: string;
    keyId: string;
    key: string;
}

export function authenticate(configs: AuthenticationConfiguration[], allowAnonymous: boolean) {
    return (req: Request, res: Response, next: NextFunction) => {
        let possibleConfigs: AuthenticationConfiguration[] = configs;

        try {
            if (req.method === "OPTIONS") {
                next();
                return;
            }
            const authorization = req.headers.authorization;
            if (authorization) {
                const match = authorization.match(/^Bearer (.*)$/);
                if (match) {
                    const token = match[1];
                    const payload = decode(token);
                    if (!payload || typeof payload !== "object") {
                        res.set('Access-Control-Allow-Origin', '*');
                        res.status(401).send("Invalid token");
                        Trace.warn(`Invalid token: ${payload}`);
                        return;
                    }

                    // Validate the subject.
                    const subject = payload.sub;
                    if (typeof subject !== "string") {
                        res.set('Access-Control-Allow-Origin', '*');
                        res.status(401).send("Invalid subject");
                        Trace.warn(`Invalid subject: ${subject}`);
                        return;
                    }

                    // Validate the issuer and audience.
                    const issuer = payload.iss;
                    possibleConfigs = configs.filter(config => config.issuer === issuer);
                    if (possibleConfigs.length === 0) {
                        res.set('Access-Control-Allow-Origin', '*');
                        res.status(401).send("Invalid issuer");
                        Trace.warn(`Invalid issuer: ${issuer}`);
                        return;
                    }
                    const audience = payload.aud;
                    possibleConfigs = possibleConfigs.filter(config => config.audience === audience);
                    if (possibleConfigs.length === 0) {
                        res.set('Access-Control-Allow-Origin', '*');
                        res.status(401).send("Invalid audience");
                        Trace.warn(`Invalid audience: ${audience}`);
                        return;
                    }

                    let verified: string | JwtPayload | undefined;
                    let provider: string = "";
                    verify(token, (header, callback) => {
                        const config = possibleConfigs.find(config => config.keyId === header.kid);
                        if (!config) {
                            callback(new Error(`Invalid key ID: ${header.kid}`));
                            return;
                        }
                        provider = config.provider;
                        callback(null, config.key);
                    }, (error, payload) => {
                        if (!error) {
                            verified = payload;
                        }
                        else {
                            Trace.warn(`Error during authentication: ${error.message || error}`);
                        }
                    });

                    if (!verified) {
                        res.set('Access-Control-Allow-Origin', '*');
                        res.status(401).send("Invalid signature");
                        Trace.warn(`Invalid signature`);
                        return;
                    }

                    // Pass the user record to the next handler.
                    const targetReq = <any>req;
                    targetReq.user = {
                        id: subject,
                        provider: provider,
                        profile: {
                            displayName: payload.display_name ?? ""
                        }
                    }
                }
            }
            else if (!allowAnonymous) {
                res.set('Access-Control-Allow-Origin', '*');
                res.status(401).send("No token");
                Trace.warn("No access token provided");
                return;
            }
            next();
        } catch (error) {
            Trace.error(error);
            next(error);
        }
    }
}

export async function loadAuthenticationConfigurations(path: string): Promise<{ configs: AuthenticationConfiguration[], allowAnonymous: boolean }> {
    const { providerFiles, hasAllowAnonymousFile } = await findProviderFiles(path);

    if (!hasAllowAnonymousFile && providerFiles.length === 0) {
        throw new Error(`No authentication configurations found in ${path}.`);
    }

    const configs: AuthenticationConfiguration[] = [];
    for (const fileName of providerFiles) {
        const config = await loadConfigurationFromFile(fileName);
        configs.push(config);
    }

    if (hasAllowAnonymousFile) {
        Trace.warn(`--------- Anonymous access is allowed!!! --------`);
    }

    return { configs, allowAnonymous: hasAllowAnonymousFile };
}

async function findProviderFiles(dir: string): Promise<{ providerFiles: string[], hasAllowAnonymousFile: boolean }> {
    const providerFiles: string[] = [];
    let hasAllowAnonymousFile = false;

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            const result = await findProviderFiles(fullPath);
            providerFiles.push(...result.providerFiles);
            hasAllowAnonymousFile = hasAllowAnonymousFile || result.hasAllowAnonymousFile;
        } else if (entry.isFile()) {
            if (entry.name.endsWith('.provider')) {
                providerFiles.push(fullPath);
            } else if (entry.name === "allow-anonymous") {
                hasAllowAnonymousFile = true;
            }
        }
    }

    return { providerFiles, hasAllowAnonymousFile };
}

async function loadConfigurationFromFile(path: string): Promise<AuthenticationConfiguration> {
    try {
        Trace.info(`Searching for authentication files in ${path}`);

        const buffer = await readFile(path);
        const encoding = chardet.detect(buffer) || 'utf-8';
        const content = iconv.decode(buffer, encoding);
        const config = JSON.parse(content);

        const missingFields = [];
        if (!config.provider) missingFields.push("provider");
        if (!config.issuer) missingFields.push("issuer");
        if (!config.audience) missingFields.push("audience");
        if (!config.key_id) missingFields.push("key_id");
        if (!config.key) missingFields.push("key");

        if (missingFields.length > 0) {
            throw new Error(`Invalid authentication configuration in ${path}: Missing required fields: ${missingFields.join(", ")}`);
        }

        return {
            provider: config.provider,
            issuer: config.issuer,
            audience: config.audience,
            keyId: config.key_id,
            key: config.key
        };
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Error loading configuration from ${path}: ${error.message}`);
        } else {
            throw new Error(`Error loading configuration from ${path}: ${String(error)}`);
        }
    }
}
