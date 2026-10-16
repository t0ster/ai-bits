import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

/**
 * Stateless OAuth artifacts signed with the server's HMAC key: registered clients,
 * authorization codes, access tokens, and refresh tokens. A distinct JWT `typ`
 * per artifact stops one kind from being accepted as another.
 */

const SIGNING_ALGORITHM = "HS256";

/** Lifetimes in seconds. */
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The single scope this server grants. */
export const MCP_SCOPE = "mcp";

type SignedArtifactType = "client+jwt" | "code+jwt" | "at+jwt" | "rt+jwt";

interface SignedArtifactKeys {
  readonly signingKey: Uint8Array;
  /** OAuth issuer; set as `iss` on every artifact. */
  readonly issuer: string;
}

async function signArtifact(
  keys: SignedArtifactKeys,
  type: SignedArtifactType,
  claims: Record<string, unknown>,
  options: { audience: string; ttlSeconds?: number },
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, typ: type })
    .setIssuer(keys.issuer)
    .setAudience(options.audience)
    .setIssuedAt()
    .setJti(crypto.randomUUID());
  if (options.ttlSeconds !== undefined) jwt.setExpirationTime(`${options.ttlSeconds}s`);
  return jwt.sign(keys.signingKey);
}

/** Verifies an artifact's signature, type, issuer, audience, and expiry; returns `undefined` when any check fails. */
async function verifyArtifact<T>(
  keys: SignedArtifactKeys,
  type: SignedArtifactType,
  token: string,
  audience: string,
  schema: z.ZodType<T>,
): Promise<(T & { jti: string; exp?: number }) | undefined> {
  try {
    const { payload } = await jwtVerify(token, keys.signingKey, {
      algorithms: [SIGNING_ALGORITHM],
      typ: type,
      issuer: keys.issuer,
      audience,
    });
    const jti = typeof payload.jti === "string" ? payload.jti : undefined;
    const claims = schema.safeParse(payload);
    if (!jti || !claims.success) return undefined;
    return { ...claims.data, jti, exp: payload.exp };
  } catch {
    return undefined;
  }
}

/** Dynamically registered OAuth client; the signed claims are the registration itself. */
export interface RegisteredOAuthClient {
  readonly redirect_uris: string[];
  readonly client_name?: string;
}

const RegisteredOAuthClientSchema = z.object({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().optional(),
});

/** Pending grant carried by an authorization code. */
export interface AuthorizationCodeGrant {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly resource: string;
  readonly scope: string;
}

const AuthorizationCodeGrantSchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  resource: z.string(),
  scope: z.string(),
});

/** Grant carried by access and refresh tokens. */
export interface TokenGrant {
  readonly client_id: string;
  readonly scope: string;
}

const TokenGrantSchema = z.object({ client_id: z.string(), scope: z.string() });

/** Signs and verifies every OAuth artifact this server issues. */
export function createOAuthSignedTokens(keys: SignedArtifactKeys) {
  const clientAudience = `${keys.issuer}/register`;
  const codeAudience = `${keys.issuer}/token`;
  const refreshAudience = `${keys.issuer}/token#refresh`;

  return {
    /** The client ID is a signed registration, so registrations survive restarts without storage. */
    signClientId: (client: RegisteredOAuthClient) =>
      signArtifact(keys, "client+jwt", { ...client }, { audience: clientAudience }),
    verifyClientId: (clientId: string) =>
      verifyArtifact(keys, "client+jwt", clientId, clientAudience, RegisteredOAuthClientSchema),

    signAuthorizationCode: (grant: AuthorizationCodeGrant) =>
      signArtifact(keys, "code+jwt", { ...grant }, {
        audience: codeAudience,
        ttlSeconds: AUTHORIZATION_CODE_TTL_SECONDS,
      }),
    verifyAuthorizationCode: (code: string) =>
      verifyArtifact(keys, "code+jwt", code, codeAudience, AuthorizationCodeGrantSchema),

    /** Access tokens use the MCP resource URL as audience so they are only valid for this MCP server. */
    signAccessToken: (grant: TokenGrant, resource: string) =>
      signArtifact(keys, "at+jwt", { ...grant }, { audience: resource, ttlSeconds: ACCESS_TOKEN_TTL_SECONDS }),
    verifyAccessToken: (token: string, resource: string) =>
      verifyArtifact(keys, "at+jwt", token, resource, TokenGrantSchema),

    signRefreshToken: (grant: TokenGrant) =>
      signArtifact(keys, "rt+jwt", { ...grant }, { audience: refreshAudience, ttlSeconds: REFRESH_TOKEN_TTL_SECONDS }),
    verifyRefreshToken: (token: string) =>
      verifyArtifact(keys, "rt+jwt", token, refreshAudience, TokenGrantSchema),
  };
}

export type OAuthSignedTokens = ReturnType<typeof createOAuthSignedTokens>;
