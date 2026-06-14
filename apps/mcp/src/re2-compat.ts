import { createRequire } from "node:module";
import type RE2Type from "re2";

const require = createRequire(import.meta.url);

let RE2Class: any;
try {
  RE2Class = require("re2");
} catch (e) {
  // If re2 fails to load (e.g. native binary compiled for a different node version,
  // or compile failed/missing node-gyp), fall back to standard RegExp.
  console.warn("kontexta-mcp: Failed to load native 're2' module, falling back to standard RegExp.");
  RE2Class = RegExp;
}

export default RE2Class as typeof RE2Type;
