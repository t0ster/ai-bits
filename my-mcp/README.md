# My Remote MCP

Give ChatGPT, Claude, or any MCP client a shell on a machine you control — a server or your own laptop.

It exposes four tools — `read`, `bash`, `edit`, `write` — behind a simple password page.

> [!WARNING]
> Anyone with the password can run commands on this machine as the user running the server. Use a strong password and HTTPS.

## Quick start

Requires [Bun](https://bun.sh).

```sh
bun install
cp .env.example .env    # fill in the values below
bun run hash-password   # prints the MCP_ACCESS_PASSWORD_HASH line
bun run start
```

Then add `<PUBLIC_URL>/mcp` as a connector in your MCP client. It opens the password page once; after that it stays signed in.

## Configuration

| Variable | |
| --- | --- |
| `MCP_ACCESS_PASSWORD_HASH` | Hash of the login password, from `bun run hash-password`. Write each `$` as `\$` |
| `TOKEN_SIGNING_SECRET` | Random secret, 32+ chars: `openssl rand -base64 48` |
| `PUBLIC_URL` | URL clients use to reach the server, e.g. `https://example.com` |
| `MCP_SERVER_NAME` | Name the model sees, e.g. `my_macbook` |
| `MCP_SERVER_DESCRIPTION` | Short description the model sees, e.g. `Staging server` |
| `HOST` | Local address to listen on (default `127.0.0.1`). Set it to the address your proxy connects to, e.g. `0.0.0.0` when the proxy runs in Docker |
| `PORT` | Local port (default `8787`) |
| `WORKSPACE_DIR` | Where commands run (default: home directory) |

Changing `TOKEN_SIGNING_SECRET` signs out every client.

## Behind a reverse proxy

Clients need HTTPS. Put the server behind nginx, Caddy, Tailscale Funnel, or similar.

To serve it under a path such as `https://example.com/my-mcp`, set `PUBLIC_URL` to that URL and have the proxy:

- strip `/my-mcp` before forwarding, and
- forward `/.well-known/oauth-protected-resource/my-mcp/…` and `/.well-known/oauth-authorization-server/my-mcp` unchanged.

```nginx
location /my-mcp/ {
  proxy_pass http://127.0.0.1:8787/;
  proxy_buffering off;
}
location ^~ /.well-known/oauth-protected-resource/my-mcp/ {
  proxy_pass http://127.0.0.1:8787;
}
location = /.well-known/oauth-authorization-server/my-mcp {
  proxy_pass http://127.0.0.1:8787;
}
```

## Development

```sh
bun run dev        # restart on file changes
bun run typecheck
```

## License

MIT
