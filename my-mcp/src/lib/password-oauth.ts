import {
  type AuthInfo,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type { ServerConfig } from "./config.ts";
import { CORS_HEADERS, isLoopbackUrl, postOnly, withCors } from "./http.ts";
import { createPasswordAuthorizationServer } from "./oauth-authorization-server.ts";
import { createOAuthSignedTokens, MCP_SCOPE } from "./oauth-tokens.ts";

/**
 * Password-protected OAuth for an MCP endpoint: the authorization-server routes,
 * discovery metadata, and a wrapper that requires a valid access token.
 *
 * Route keys are the paths this server receives. With a `PUBLIC_URL` path prefix, the reverse
 * proxy strips the prefix from app routes (`/my-mcp/token` arrives as `/token`) but forwards the
 * origin-root discovery paths unchanged (`/.well-known/oauth-authorization-server/my-mcp`).
 */
export function createPasswordOAuth(config: ServerConfig, options: { resourceName: string }) {
  const issuer = config.publicUrl;
  const resource = config.mcpResourceUrl;
  const signedTokens = createOAuthSignedTokens({ signingKey: config.tokenSigningKey, issuer });
  const authorizationServer = createPasswordAuthorizationServer({
    issuer,
    mcpResourceUrl: resource,
    accessPasswordHash: config.accessPasswordHash,
    signedTokens,
  });

  const protectedResourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const protectedResourceMetadata = Response.json(
    buildOAuthProtectedResourceMetadata({
      oauthMetadata: authorizationServer.oauthMetadata,
      resourceServerUrl: resource,
      scopesSupported: [MCP_SCOPE],
      resourceName: options.resourceName,
      dangerouslyAllowInsecureIssuerUrl: isLoopbackUrl(new URL(issuer)),
    }),
    { headers: CORS_HEADERS },
  );
  const authorizationServerMetadata = Response.json(authorizationServer.oauthMetadata, { headers: CORS_HEADERS });

  const verifyMcpAccessToken = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        const grant = await signedTokens.verifyAccessToken(token, resource.href);
        if (!grant) throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token is invalid or expired");
        return { token, clientId: grant.client_id, scopes: grant.scope.split(" "), expiresAt: grant.exp, resource };
      },
    },
    requiredScopes: [MCP_SCOPE],
    expectedResource: resource,
    resourceMetadataUrl: protectedResourceMetadataUrl,
  });

  return {
    /** Bun routes for the authorization server and discovery metadata. */
    routes: {
      // RFC 9728 path-aware location, the URL advertised in 401 challenges.
      [new URL(protectedResourceMetadataUrl).pathname]: protectedResourceMetadata,
      // Fallback for clients that only probe the issuer-relative location.
      "/.well-known/oauth-protected-resource": protectedResourceMetadata,
      // RFC 8414 location for an issuer with a path: /.well-known/oauth-authorization-server/my-mcp.
      [`/.well-known/oauth-authorization-server${config.publicBasePath}`]: authorizationServerMetadata,
      // Fallback for clients that append the well-known path to the issuer URL.
      "/.well-known/oauth-authorization-server": authorizationServerMetadata,
      "/authorize": {
        GET: (request: Request) => authorizationServer.showPasswordPage(request),
        POST: (request: Request) => authorizationServer.submitPassword(request),
      },
      "/token": withCors(postOnly(authorizationServer.exchangeToken)),
      "/register": withCors(postOnly(authorizationServer.registerClient)),
    },

    /** Wraps an MCP handler so it only runs with a valid access token; otherwise answers 401/403 with an OAuth challenge. */
    requireAccessToken(handler: (request: Request, authInfo: AuthInfo) => Promise<Response>) {
      return withCors(async (request) => {
        const authInfo = await verifyMcpAccessToken(request);
        if (authInfo instanceof Response) return authInfo;
        return handler(request, authInfo);
      });
    },
  };
}
