import * as chardet from "chardet";
import { NextFunction, Request, Response } from "express";
import { readdir, readFile } from "fs/promises";
import * as iconv from "iconv-lite";
import { Trace } from "jinaga";
import { Algorithm, decode, JwtHeader, JwtPayload, verify } from "jsonwebtoken";
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

// A PEM-encoded asymmetric key (or certificate) begins with a structured
// header line such as "-----BEGIN PUBLIC KEY-----". A loose substring check
// would misclassify a symmetric secret that merely contains "-----BEGIN".
function isPemKey(key: string): boolean {
    return /-----BEGIN (?:[A-Z0-9]+ )*(?:PUBLIC KEY|CERTIFICATE)-----/.test(key);
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
                    const decoded = decode(token, { complete: true });
                    const payload = decoded?.payload;
                    if (!decoded || !payload || typeof payload !== "object") {
                        res.set('Access-Control-Allow-Origin', '*');
                        res.status(401).send("Invalid token");
                        Trace.warn(`Invalid token: ${payload}`);
                        return;
                    }
                    const header = decoded.header;

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
                        // Resolve the single config (and its key) that matches this
                        // token's kid, then verify with an algorithm allowlist scoped
                        // to that key alone — never a union across providers, which
                        // would reopen the RS256->HS256 confusion an allowlist closes.
                        const resolution = await resolveVerificationKey(header, possibleConfigs);
                        if (resolution) {
                            verified = await verifyToken(token, resolution.key, resolution.algorithms);
                            provider = resolution.provider;
                        } else {
                            Trace.warn(`No signing key for key ID: ${header.kid}`);
                        }
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

interface ResolvedVerificationKey {
    key: string;
    algorithms: Algorithm[];
    provider: string;
}

// Resolve the signing key for a token by its `kid`, supporting both static keys
// (matched by `key_id`) and dynamic JWKS endpoints (resolved by `kid`, with
// caching and cache-miss refetch handled by jwks-rsa). Resolution is
// asynchronous because a JWKS lookup may require a network round-trip.
//
// Exactly one config (and therefore one key) is selected, so the algorithm
// allowlist returned alongside it is scoped to that key's type alone — RS256
// for asymmetric/JWKS keys, the HMAC family for symmetric secrets. This is
// deliberate: a union of algorithms across providers sharing an issuer/audience
// would let an attacker present `alg: HS256` against a PEM public key
// (algorithm-confusion).
async function resolveVerificationKey(
    header: JwtHeader,
    possibleConfigs: AuthenticationConfiguration[]
): Promise<ResolvedVerificationKey | undefined> {
    // A `kid` is required to select a key in both modes; fail fast without one.
    const kid = header.kid;
    if (!kid) {
        return undefined;
    }

    // Prefer a static key whose key_id matches the token's kid.
    const staticConfig = possibleConfigs.find(config => config.key !== undefined && config.keyId === kid);
    if (staticConfig && staticConfig.key !== undefined) {
        return {
            key: staticConfig.key,
            algorithms: isPemKey(staticConfig.key) ? RSA_ALGORITHMS : HMAC_ALGORITHMS,
            provider: staticConfig.provider
        };
    }

    // Otherwise try each JWKS endpoint, resolving by kid. Trying each (rather
    // than blindly taking the first) disambiguates when more than one JWKS
    // provider shares the issuer/audience: the one that actually publishes the
    // kid wins.
    for (const config of possibleConfigs) {
        if (config.jwksClient) {
            const key = await getSigningKey(config.jwksClient, kid);
            if (key) {
                return {
                    key,
                    algorithms: RSA_ALGORITHMS,
                    provider: config.provider
                };
            }
        }
    }

    return undefined;
}

// Promisified jwks-rsa key lookup. Resolves to the PEM public key for the kid,
// or undefined if the endpoint does not publish it (or the fetch fails).
function getSigningKey(client: jwksRsa.JwksClient, kid: string): Promise<string | undefined> {
    return new Promise(resolve => {
        client.getSigningKey(kid, (error, key) => {
            resolve(error || !key ? undefined : key.getPublicKey());
        });
    });
}

// Verify a token against a single resolved key, constrained to the explicit
// algorithm allowlist for that key.
function verifyToken(token: string, key: string, algorithms: Algorithm[]): Promise<string | JwtPayload> {
    return new Promise((resolve, reject) => {
        verify(token, key, { algorithms }, (error, payload) => {
            if (error || !payload) {
                reject(error ?? new Error("Token verification produced no payload"));
                return;
            }
            resolve(payload);
        });
    });
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
