import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader. Node's --env-file flag aborts when the file is missing, and this project
 * must start with or without a .env present. Real environment variables always win.
 */
export function loadEnvFile(rootDirectory, env = process.env) {
  const file = path.join(rootDirectory, ".env");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { loaded: false, file };
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!key || key in env) continue;
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    env[key] = value;
  }

  return { loaded: true, file };
}
