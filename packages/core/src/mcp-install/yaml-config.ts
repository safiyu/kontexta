import { existsSync, readFileSync } from "node:fs";
import { Document, isMap, parseDocument } from "yaml";

export type YamlDoc = Document.Parsed | Document;

// Parses a config so it can be edited in place (comments and untouched keys survive); refuses anything it could damage.
export function loadYamlDoc(path: string): YamlDoc {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.trim() === "") return new Document({});
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML (${doc.errors[0].message.split("\n")[0]}); refusing to overwrite it`);
  if (!isMap(doc.contents)) throw new Error(`${path} top level is not a mapping; refusing to overwrite it`);
  return doc;
}

// lineWidth 0 keeps long commands on one line so they stay readable and auditable.
export const dumpYaml = (doc: YamlDoc): string => doc.toString({ lineWidth: 0 });
