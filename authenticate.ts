import { Request, Response, NextFunction } from "express";
import { decode, JwtPayload, verify, Algorithm } from "jsonwebtoken";

const CLOCK_SKEW = 30; // 30 seconds

interface AuthenticationConfiguration {
    provider: string;
    issuer: string;
    audience: string;
    algorithm: string;
    publicKey?: string;
    sharedKey?: string;
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
    const configs: AuthenticationConfiguration[] = [];
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
        next();
    } catch (error) {
        next(error);
    }
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

function validateSharedKeyAlgorithm(alg: string) : Algorithm | undefined {
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