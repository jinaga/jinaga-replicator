import * as chardet from "chardet";
import { NextFunction, Request, Response } from "express";
import { readdir, readFile } from "fs/promises";
import * as iconv from "iconv-lite";
import { Trace } from "jinaga";
import { Algorithm, decode, GetPublicKeyOrSecret, JwtHeader, JwtPayload, SigningKeyCallback, verify } from "jsonwebtoken";
import jwksRsa = require("jwks-rsa");
import { join } from "path";

interface AuthenticationConfiguration {
    provider: string;
    issuer: string;
    audience: string;
    keyId?: string;
    key?: string;
    jwksUri?: string;
    jwksClient?: jwksRsa.JwksClient;
}

const RSA_ALGORITHMS: Algorithm[] = ["RS256"];
const HMAC_ALGORITHMS: Algorithm[] = ["HS256", "HS384", "HS512"];

function isPemKey(key: string): boolean {
    return key.includes("-----BEGIN");
}

export function authenticate(configs: AuthenticationConfiguration[], allowAnonymous: boolean) {
    return async (req: Request, res: Response, next: NextFunction) => {
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
                    try {
                        const result = await verifyToken(token, possibleConfigs);
                        verified = result.payload;
                        provider = result.provider;
                    } catch (error) {
                        Trace.warn(`Error during authentication: ${error instanceof Error ? error.message : error}`);
                    }

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

// Resolve the signing key for a token by its `kid`, supporting both static keys
// (matched by `key_id`) and dynamic JWKS endpoints (resolved by `kid`, with
// caching and cache-miss refetch handled by jwks-rsa). The verification is
// asynchronous because JWKS resolution may require a network round-trip.
function verifyToken(
    token: string,
    possibleConfigs: AuthenticationConfiguration[]
): Promise<{ payload: string | JwtPayload; provider: string }> {
    return new Promise((resolve, reject) => {
        let provider: string = "";

        const getKey: GetPublicKeyOrSecret = (header: JwtHeader, callback: SigningKeyCallback) => {
            // Prefer a static key whose key_id matches the token's kid.
            const staticConfig = possibleConfigs.find(config => config.key !== undefined && config.keyId === header.kid);
            if (staticConfig) {
                provider = staticConfig.provider;
                callback(null, staticConfig.key);
                return;
            }

            // Fall back to a JWKS endpoint, resolving the key by kid.
            const jwksConfig = possibleConfigs.find(config => config.jwksClient !== undefined);
            if (jwksConfig && jwksConfig.jwksClient) {
                provider = jwksConfig.provider;
                jwksConfig.jwksClient.getSigningKey(header.kid, (error, key) => {
                    if (error || !key) {
                        callback(error ?? new Error(`Invalid key ID: ${header.kid}`));
                        return;
                    }
                    callback(null, key.getPublicKey());
                });
                return;
            }

            callback(new Error(`Invalid key ID: ${header.kid}`));
        };

        verify(token, getKey, { algorithms: allowedAlgorithms(possibleConfigs) }, (error, payload) => {
            if (error || !payload) {
                reject(error ?? new Error("Token verification produced no payload"));
                return;
            }
            resolve({ payload, provider });
        });
    });
}

// Compute the explicit algorithms allowlist (defense-in-depth against
// algorithm-confusion attacks such as RS256 -> HS256). Asymmetric keys (PEM or
// JWKS) permit RS256; static symmetric secrets permit the HMAC family.
function allowedAlgorithms(possibleConfigs: AuthenticationConfiguration[]): Algorithm[] {
    const algorithms = new Set<Algorithm>();
    for (const config of possibleConfigs) {
        if (config.jwksUri !== undefined || (config.key !== undefined && isPemKey(config.key))) {
            RSA_ALGORITHMS.forEach(algorithm => algorithms.add(algorithm));
        } else if (config.key !== undefined) {
            HMAC_ALGORITHMS.forEach(algorithm => algorithms.add(algorithm));
        }
    }
    return [...algorithms];
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
        const encoding = (chardet.detect(buffer as any) || 'utf-8').toLowerCase();
        const content = iconv.decode(buffer, encoding);
        const config = JSON.parse(content);

        const missingFields = [];
        if (!config.provider) missingFields.push("provider");
        if (!config.issuer) missingFields.push("issuer");
        if (!config.audience) missingFields.push("audience");

        if (missingFields.length > 0) {
            throw new Error(`Invalid authentication configuration in ${path}: Missing required fields: ${missingFields.join(", ")}`);
        }

        const hasJwksUri = !!config.jwks_uri;
        const hasStaticKey = !!config.key || !!config.key_id;

        // A provider declares either a JWKS endpoint or a static key, not both.
        if (hasJwksUri && hasStaticKey) {
            throw new Error(`Invalid authentication configuration in ${path}: jwks_uri is mutually exclusive with key and key_id.`);
        }

        if (hasJwksUri) {
            if (typeof config.jwks_uri !== "string" || !/^https?:\/\//.test(config.jwks_uri)) {
                throw new Error(`Invalid authentication configuration in ${path}: jwks_uri must be an http(s) URL.`);
            }

            return {
                provider: config.provider,
                issuer: config.issuer,
                audience: config.audience,
                jwksUri: config.jwks_uri,
                jwksClient: new jwksRsa.JwksClient({
                    jwksUri: config.jwks_uri,
                    cache: true,
                    cacheMaxEntries: 5,
                    cacheMaxAge: 600000,
                    rateLimit: true,
                    jwksRequestsPerMinute: 10
                })
            };
        }

        const missingKeyFields = [];
        if (!config.key_id) missingKeyFields.push("key_id");
        if (!config.key) missingKeyFields.push("key");

        if (missingKeyFields.length > 0) {
            throw new Error(`Invalid authentication configuration in ${path}: Provide either jwks_uri or a static key. Missing required fields: ${missingKeyFields.join(", ")}`);
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
