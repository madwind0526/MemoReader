// Frontmatter is a strict YAML subset: every value is written as JSON, which is valid YAML (quoted
// strings, flow sequences, numbers, booleans). That keeps files Obsidian-compatible while parsing
// stays a one-liner per line.

export function serializeFrontmatter(meta, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

export function parseFrontmatter(text) {
  const source = String(text).replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!entry) continue;
    try {
      meta[entry[1]] = JSON.parse(entry[2]);
    } catch {
      meta[entry[1]] = entry[2];
    }
  }
  return { meta, body: source.slice(match[0].length).replace(/^\r?\n/, "") };
}
