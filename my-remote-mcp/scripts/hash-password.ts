/**
 * Prints the MCP_ACCESS_PASSWORD_HASH line for .env.
 *
 * Usage: bun run hash-password            (prompts for the password)
 *        echo -n "secret" | bun run hash-password
 *
 * Every `$` is escaped as `\$` because Bun expands `$` in .env values, even inside quotes.
 */
const password = process.stdin.isTTY ? prompt("Password:") : (await Bun.stdin.text()).replace(/\r?\n$/, "");
if (!password) {
  console.error("hash-password: password is empty");
  process.exit(1);
}

const hash = await Bun.password.hash(password, "argon2id");
console.log(`MCP_ACCESS_PASSWORD_HASH=${hash.replaceAll("$", "\\$")}`);
