/** Renders the HTML password page shown during OAuth authorization. */
export function renderPasswordPage(options: {
  /** Absolute URL of the authorization endpoint the form posts to. */
  formAction: string;
  /** Authorization request parameters echoed back as hidden form fields. */
  hiddenFields: Record<string, string>;
  errorMessage?: string;
  clientName?: string;
}): string {
  const hiddenInputs = Object.entries(options.hiddenFields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n      ");
  const error = options.errorMessage ? `<p class="error" role="alert">${escapeHtml(options.errorMessage)}</p>` : "";
  const client = options.clientName ? ` for ${escapeHtml(options.clientName)}` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize MCP access</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    form { background: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 4px #0002; width: min(22rem, 90vw); }
    h1 { font-size: 1.25rem; margin-top: 0; }
    label { display: block; margin-bottom: .5rem; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem; font-size: 1rem; }
    button { margin-top: 1rem; width: 100%; padding: .6rem; font-size: 1rem; cursor: pointer; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <form method="post" action="${escapeHtml(options.formAction)}">
    <h1>Authorize MCP access${client}</h1>
    ${error}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      ${hiddenInputs}
    <button type="submit">Allow access</button>
  </form>
</body>
</html>`;
}

/** Renders a plain error page for authorization requests that cannot be redirected back to the client. */
export function renderAuthorizationErrorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem"><h1>Authorization error</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
