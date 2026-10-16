import { createHash } from "node:crypto";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  MCP_SCOPE,
  type OAuthSignedTokens,
  type RegisteredOAuthClient,
} from "./oauth-tokens.ts";
import { renderAuthorizationErrorPage, renderPasswordPage } from "./password-page.ts";

/**
 * OAuth 2.1 authorization server whose only login step is a shared password:
 * dynamic client registration, the authorization-code + PKCE (S256) flow, and refresh tokens.
 */

export interface PasswordAuthorizationServerOptions {
  /** OAuth issuer; the public origin of this server. */
  readonly issuer: string;
  /** The MCP resource identifier tokens are issued for. */
  readonly mcpResourceUrl: URL;
  /** Bun.password hash of the login password. */
  readonly accessPasswordHash: string;
  readonly signedTokens: OAuthSignedTokens;
}

/** Authorization server endpoint handlers plus the RFC 8414 metadata advertising them. */
export function createPasswordAuthorizationServer(options: PasswordAuthorizationServerOptions) {
  const { issuer, signedTokens } = options;
  const resource = options.mcpResourceUrl.href;
  const usedAuthorizationCodes = new Map<string, number>();

  const oauthMetadata: OAuthMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };

  /** Validates an authorization request; distinguishes errors that must not be redirected to an unverified URI. */
  async function parseAuthorizationRequest(params: URLSearchParams): Promise<
    | { kind: "valid"; request: ValidAuthorizationRequest; client: RegisteredOAuthClient }
    | { kind: "show_error"; message: string }
    | { kind: "redirect_error"; redirectUri: string; state?: string; error: string; description: string }
  > {
    const clientId = params.get("client_id");
    if (!clientId) return { kind: "show_error", message: "Missing client_id." };
    const client = await signedTokens.verifyClientId(clientId);
    if (!client) return { kind: "show_error", message: "Unknown client. Reconnect the MCP client to register again." };

    const requestedRedirectUri = params.get("redirect_uri") ?? undefined;
    const redirectUri =
      requestedRedirectUri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return { kind: "show_error", message: "redirect_uri is missing or not registered for this client." };
    }

    const state = params.get("state") ?? undefined;
    const fail = (error: string, description: string) =>
      ({ kind: "redirect_error", redirectUri, state, error, description }) as const;

    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code.");
    const codeChallenge = params.get("code_challenge");
    if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      return fail("invalid_request", "A S256 code_challenge is required.");
    }
    if (params.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "code_challenge_method must be S256.");
    }
    const requestedResource = params.get("resource");
    if (requestedResource !== null && !isSameResource(requestedResource, resource)) {
      return fail("invalid_target", `resource must be ${resource}.`);
    }

    return {
      kind: "valid",
      client,
      request: { clientId, redirectUri, state, codeChallenge },
    };
  }

  function authorizationErrorResponse(
    result: Exclude<Awaited<ReturnType<typeof parseAuthorizationRequest>>, { kind: "valid" }>,
  ): Response {
    if (result.kind === "show_error") return htmlResponse(renderAuthorizationErrorPage(result.message), 400);
    const location = new URL(result.redirectUri);
    location.searchParams.set("error", result.error);
    location.searchParams.set("error_description", result.description);
    if (result.state !== undefined) location.searchParams.set("state", result.state);
    location.searchParams.set("iss", issuer);
    return Response.redirect(location.href, 303);
  }

  /** GET /authorize: shows the password page for a valid authorization request. */
  async function showPasswordPage(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const result = await parseAuthorizationRequest(params);
    if (result.kind !== "valid") return authorizationErrorResponse(result);
    return htmlResponse(
      renderPasswordPage({
        formAction: oauthMetadata.authorization_endpoint,
        hiddenFields: authorizationHiddenFields(params),
        clientName: result.client.client_name,
      }),
      200,
    );
  }

  /** POST /authorize: checks the password and redirects back to the client with an authorization code. */
  async function submitPassword(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const result = await parseAuthorizationRequest(form);
    if (result.kind !== "valid") return authorizationErrorResponse(result);
    const hiddenFields = authorizationHiddenFields(form);
    const clientName = result.client.client_name;

    if (!(await isCorrectPassword(form.get("password") ?? "", options.accessPasswordHash))) {
      return htmlResponse(
        renderPasswordPage({
          formAction: oauthMetadata.authorization_endpoint,
          hiddenFields,
          clientName,
          errorMessage: "Incorrect password.",
        }),
        401,
      );
    }

    const { clientId, redirectUri, state, codeChallenge } = result.request;
    const code = await signedTokens.signAuthorizationCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      resource,
      scope: MCP_SCOPE,
    });
    const location = new URL(redirectUri);
    location.searchParams.set("code", code);
    if (state !== undefined) location.searchParams.set("state", state);
    location.searchParams.set("iss", issuer);
    return Response.redirect(location.href, 303);
  }

  /** POST /token: exchanges an authorization code or refresh token for tokens. */
  async function exchangeToken(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const clientId = form.get("client_id");
    if (!clientId || !(await signedTokens.verifyClientId(clientId))) {
      return tokenErrorResponse("invalid_client", "Unknown client_id.", 401);
    }
    const requestedResource = form.get("resource");
    if (requestedResource !== null && !isSameResource(requestedResource, resource)) {
      return tokenErrorResponse("invalid_target", `resource must be ${resource}.`);
    }

    switch (form.get("grant_type")) {
      case "authorization_code":
        return exchangeAuthorizationCode(form, clientId);
      case "refresh_token":
        return exchangeRefreshToken(form, clientId);
      default:
        return tokenErrorResponse("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
    }
  }

  async function exchangeAuthorizationCode(form: URLSearchParams, clientId: string): Promise<Response> {
    const grant = await signedTokens.verifyAuthorizationCode(form.get("code") ?? "");
    if (!grant || grant.client_id !== clientId) {
      return tokenErrorResponse("invalid_grant", "Authorization code is invalid or expired.");
    }
    if (form.get("redirect_uri") !== grant.redirect_uri) {
      return tokenErrorResponse("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    const codeVerifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier) || pkceS256Challenge(codeVerifier) !== grant.code_challenge) {
      return tokenErrorResponse("invalid_grant", "PKCE code_verifier does not match code_challenge.");
    }
    if (!markAuthorizationCodeUsed(grant.jti, grant.exp)) {
      return tokenErrorResponse("invalid_grant", "Authorization code was already used.");
    }
    return issueTokens({ client_id: clientId, scope: grant.scope });
  }

  async function exchangeRefreshToken(form: URLSearchParams, clientId: string): Promise<Response> {
    const grant = await signedTokens.verifyRefreshToken(form.get("refresh_token") ?? "");
    if (!grant || grant.client_id !== clientId) {
      return tokenErrorResponse("invalid_grant", "Refresh token is invalid or expired.");
    }
    return issueTokens({ client_id: clientId, scope: grant.scope });
  }

  async function issueTokens(grant: { client_id: string; scope: string }): Promise<Response> {
    return jsonResponse(
      {
        access_token: await signedTokens.signAccessToken(grant, resource),
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: await signedTokens.signRefreshToken(grant),
        scope: grant.scope,
      },
      200,
    );
  }

  /** Single-use enforcement for authorization codes; returns false when the code was already used. */
  function markAuthorizationCodeUsed(jti: string, exp: number | undefined): boolean {
    const nowSeconds = Date.now() / 1000;
    for (const [usedJti, usedExp] of usedAuthorizationCodes) {
      if (usedExp < nowSeconds) usedAuthorizationCodes.delete(usedJti);
    }
    if (usedAuthorizationCodes.has(jti)) return false;
    usedAuthorizationCodes.set(jti, exp ?? nowSeconds);
    return true;
  }

  /** POST /register: RFC 7591 dynamic client registration for public clients. */
  async function registerClient(request: Request): Promise<Response> {
    const body = ClientRegistrationRequestSchema.safeParse(await request.json().catch(() => undefined));
    if (!body.success) {
      return jsonResponse({ error: "invalid_client_metadata", error_description: z.prettifyError(body.error) }, 400);
    }
    const invalidRedirectUri = body.data.redirect_uris.find((uri) => !isAllowedRedirectUri(uri));
    if (invalidRedirectUri) {
      return jsonResponse(
        {
          error: "invalid_redirect_uri",
          error_description: `Redirect URI must use https or loopback http without a fragment: ${invalidRedirectUri}`,
        },
        400,
      );
    }

    const client: RegisteredOAuthClient = {
      redirect_uris: body.data.redirect_uris,
      ...(body.data.client_name ? { client_name: body.data.client_name } : {}),
    };
    return jsonResponse(
      {
        client_id: await signedTokens.signClientId(client),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...client,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  return { oauthMetadata, showPasswordPage, submitPassword, exchangeToken, registerClient };
}

interface ValidAuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly codeChallenge: string;
}

const ClientRegistrationRequestSchema = z.object({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().max(200).optional(),
});

/** Authorization request parameters carried through the password form. */
const AUTHORIZATION_PARAMETER_NAMES = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;

function authorizationHiddenFields(params: URLSearchParams): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of AUTHORIZATION_PARAMETER_NAMES) {
    const value = params.get(name);
    if (value !== null) fields[name] = value;
  }
  return fields;
}

function isAllowedRedirectUri(uri: string): boolean {
  if (!URL.canParse(uri)) return false;
  const url = new URL(uri);
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Compares resource identifiers ignoring one trailing slash. */
function isSameResource(candidate: string, resource: string): boolean {
  const normalize = (value: string) => value.replace(/\/$/, "");
  return normalize(candidate) === normalize(resource);
}

function pkceS256Challenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

/** Checks a submitted password against the configured hash; an empty password never matches. */
async function isCorrectPassword(password: string, passwordHash: string): Promise<boolean> {
  return password.length > 0 && (await Bun.password.verify(password, passwordHash));
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // No form-action: browsers apply it to the post-login redirect to the client's redirect_uri.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function tokenErrorResponse(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status);
}
