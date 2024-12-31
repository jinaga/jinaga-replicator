import { Request, Response, NextFunction } from "express";
import { decode, JwtPayload, verify, Algorithm } from "jsonwebtoken";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import * as chardet from "chardet";
import * as iconv from "iconv-lite";

const CLOCK_SKEW = 30; // 30 seconds

interface AuthenticationConfiguration {
    provider: string;
    issuer: string;
    audience: string;
    algorithm: string;
    publicKey?: string;
    sharedKey?: string;
}

export function authenticate(configs: AuthenticationConfiguration[], allowAnonymous: boolean) {
    return (req: Request, res: Response, next: NextFunction) => {
        let possibleConfigs: AuthenticationConfiguration[] = configs;

        try {
            const authorization = req.headers.authorization;
            if (authorization) {
                const match = authorization.match(/^Bearer (.*)$/);
                if (match) {
                    const token = match[1];
                    const payload = decode(token);
                    if (!payload || typeof payload !== "object") {
                        res.status(401).send("Invalid token");
                        return;
                    }

                    // Validate the subject.
                    const subject = payload.sub;
                    if (typeof subject !== "string") {
                        res.status(401).send("Invalid subject");
                        return;
                    }

                    // Validate the issuer and audience.
                    const issuer = payload.iss;
                    possibleConfigs = configs.filter(config => config.issuer === issuer);
                    if (possibleConfigs.length === 0) {
                        res.status(401).send("Invalid issuer");
                        return;
                    }
                    const audience = payload.aud;
                    possibleConfigs = possibleConfigs.filter(config => config.audience === audience);
                    if (possibleConfigs.length === 0) {
                        res.status(401).send("Invalid audience");
                        return;
                    }

                    // Validate the algorithm.
                    if (typeof payload.alg !== "string") {
                        res.status(401).send("Invalid algorithm");
                        return;
                    }
                    possibleConfigs = possibleConfigs.filter(config => config.algorithm === payload.alg);
                    if (possibleConfigs.length === 0) {
                        res.status(401).send("Invalid algorithm");
                        return;
                    }
                    const publicKeyAlgorithm = validatePublicKeyAlgorithm(payload.alg);
                    const sharedKeyAlgorithm = validateSharedKeyAlgorithm(payload.alg);
                    const algorithm = publicKeyAlgorithm ?? sharedKeyAlgorithm;
                    if (!algorithm) {
                        res.status(401).send("Invalid algorithm");
                        return;
                    }

                    let verified: string | JwtPayload = "";
                    let provider: string = "";
                    // Try each possible configuration to find the matching public key.
                    for (const config of possibleConfigs) {
                        const publicKeyOrSecret = publicKeyAlgorithm ? config.publicKey : config.sharedKey;
                        if (!publicKeyOrSecret) {
                            continue;
                        }
                        try {
                            // Validate the signature.
                            verified = verify(token, publicKeyOrSecret, {
                                algorithms: [algorithm],
                                clockTolerance: CLOCK_SKEW
                            });
                        } catch (error) {
                            continue;
                        }

                        if (verified) {
                            provider = config.provider;
                            break;
                        }
                    }

                    if (!verified) {
                        res.status(401).send("Invalid signature");
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
                res.status(401).send("No token");
                return;
            }
            next();
        } catch (error) {
            next(error);
        }
    }
}

export async function loadAuthenticationConfigurations(path: string): Promise<{ configs: AuthenticationConfiguration[], allowAnonymous: boolean }> {
    const { providerFiles, hasAllowAnonymousFile } = await findProviderFiles(path);

    if (providerFiles.length === 0) {
        return { configs: [], allowAnonymous: true };
    }

    const configs: AuthenticationConfiguration[] = [];
    for (const fileName of providerFiles) {
        const config = await loadConfigurationFromFile(fileName);
        configs.push(config);
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
    const buffer = await readFile(path);
    const encoding = chardet.detect(buffer) || 'utf-8';
    const content = iconv.decode(buffer, encoding);
    const config = JSON.parse(content);

    if (!config.provider || !config.issuer || !config.audience || !config.algorithm) {
        throw new Error(`Invalid authentication configuration in ${path}`);
    }

    const publicKeyAlgorithm = validatePublicKeyAlgorithm(config.algorithm);
    if (publicKeyAlgorithm && !config.public_key) {
        throw new Error(`Public key missing in ${path}`);
    }
    const sharedKeyAlgorithm = validateSharedKeyAlgorithm(config.algorithm);
    if (sharedKeyAlgorithm && !config.shared_key) {
        throw new Error(`Shared key missing in ${path}`);
    }
    if (!publicKeyAlgorithm && !sharedKeyAlgorithm) {
        throw new Error(`Invalid algorithm in ${path}`);
    }

    return {
        provider: config.provider,
        issuer: config.issuer,
        audience: config.audience,
        algorithm: config.algorithm,
        publicKey: config.public_key,
        sharedKey: config.shared_key
    };
}

function validatePublicKeyAlgorithm(alg: string): Algorithm | undefined {
    switch (alg) {
        case 'RS256':
            return 'RS256';
        case 'RS384':
            return 'RS384';
        case 'RS512':
            return 'RS512';
        case 'ES256':
            return 'ES256';
        case 'ES384':
            return 'ES384';
        case 'ES512':
            return 'ES512';
        case 'PS256':
            return 'PS256';
        case 'PS384':
            return 'PS384';
        case 'PS512':
            return 'PS512';
        default:
            return undefined;
    }
}

function validateSharedKeyAlgorithm(alg: string): Algorithm | undefined {
    switch (alg) {
        case 'HS256':
            return 'HS256';
        case 'HS384':
            return 'HS384';
        case 'HS512':
            return 'HS512';
        default:
            return undefined;
    }
}