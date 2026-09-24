/**
 * Normalizes a DeepSeek web-chat user token supplied by the extension owner.
 * The extension never ships or substitutes a credential.
 */
export function cleanToken(raw) {
  if (!raw) return "";
  let str = String(raw).trim();

  // Accept a copied localStorage entry that contains the actual userToken.
  if (str.includes('"userToken"')) {
    try {
      const entries = JSON.parse(str);
      if (Array.isArray(entries)) {
        const entry = entries.find((item) => item?.key === "userToken");
        if (typeof entry?.value === "string") return cleanToken(entry.value);
      }
    } catch {
      // Fall through to the tolerant text extraction below.
    }
    const match = str.match(/"userToken"[\s\S]*?"value"[\s:]+"([^"]+)"/);
    if (match?.[1]) return cleanToken(match[1]);
  }

  // Accept simple JSON wrappers while rejecting settings JWTs.
  if (str.startsWith("{") && str.endsWith("}")) {
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed?.value === "string") str = parsed.value.trim();
      else if (typeof parsed?.value?.jwt === "string") return "";
    } catch {
      // Keep non-JSON input and normalize it below.
    }
  }

  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }
  if (str.toLowerCase().startsWith("bearer ")) str = str.slice(7).trim();

  // Support common copied-cookie forms such as userToken=xyz.
  if (str.includes("=")) {
    const [, value] = str.split(";", 1)[0].split("=", 2);
    if (value) str = value.trim();
  }

  str = str.replace(/^["']+|["']+$/g, "").trim();
  return str.startsWith("eyJ") ? "" : str;
}
