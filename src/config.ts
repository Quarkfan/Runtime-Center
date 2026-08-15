export function requireInternalServiceToken(
  env: NodeJS.ProcessEnv = process.env,
) {
  const token = env.INTERNAL_SERVICE_TOKEN;
  if (!token || token.length < 32)
    throw new Error("INTERNAL_SERVICE_TOKEN must contain at least 32 characters");
  return token;
}

export function requireBrowserStateKey(
  env: NodeJS.ProcessEnv = process.env,
) {
  const encoded = env.BROWSER_STATE_KEY_BASE64;
  if (!encoded) throw new Error("BROWSER_STATE_KEY_BASE64 is required");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32)
    throw new Error("BROWSER_STATE_KEY_BASE64 must decode to 32 bytes");
  return key;
}
