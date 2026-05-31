const fs = require("fs");
const path = require("path");

// Files to process (workspace-relative)
const files = [
  "src/validation/schema-storage.ts",
  "src/validation/index.ts",
  "src/validation/drift-detector.ts",
  "src/strategies/retry.ts",
  "src/strategies/rate-limit.ts",
  "src/strategies/rate-limit.test.ts",
  "src/strategies/pagination.ts",
  "src/strategies/index.ts",
  "src/strategies/idempotency.ts",
  "src/strategies/circuit-breaker.ts",
  "src/safety.test.ts",
  "src/providers/github/pagination.ts",
  "src/providers/github/index.ts",
  "src/providers/github/adapter.ts",
  "src/providers/github/adapter.test.ts",
  "src/index.ts",
  "src/index.test.ts",
  "src/observability/sanitizer.test.ts",
  "src/observability/prometheus.ts",
  "src/observability/otel.ts",
  "src/observability/noop.ts",
  "src/observability/index.ts",
  "src/observability/console.ts",
  "src/observability/adapter.ts",
  "src/core/versioning.ts",
  "src/core/types.ts",
  "src/core/request-sanitizer.ts",
  "src/core/pipeline.ts",
  "src/core/observability-sanitizer.ts",
  "src/core/normalizer.ts",
  "src/core/header-parser.ts",
  "src/core/error-sanitizer.ts",
  "src/core/error-mapper.ts",
  "src/core/adapter-validator.ts",
  "examples/basic-usage.ts",
];

function stripComments(code) {
  let out = "";
  const len = code.length;
  let i = 0;
  let inSingle = false,
    inDouble = false,
    inTemplate = false;
  let inLineComment = false,
    inBlockComment = false;

  while (i < len) {
    const ch = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === "/" && next === "/") {
        inLineComment = true;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
    }

    if (!inSingle && !inDouble && ch === "`" && !inTemplate) {
      inTemplate = true;
      out += ch;
      i++;
      continue;
    }

    if (!inSingle && !inTemplate && ch === '"') {
      inDouble = !inDouble;
      out += ch;
      i++;
      while (inDouble && i < len) {
        const c = code[i];
        out += c;
        if (c === "\\") {
          if (i + 1 < len) {
            out += code[i + 1];
            i += 2;
            continue;
          }
        }
        if (c === '"') {
          inDouble = false;
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (!inDouble && !inTemplate && ch === "'") {
      inSingle = !inSingle;
      out += ch;
      i++;
      while (inSingle && i < len) {
        const c = code[i];
        out += c;
        if (c === "\\") {
          if (i + 1 < len) {
            out += code[i + 1];
            i += 2;
            continue;
          }
        }
        if (c === "'") {
          inSingle = false;
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (inTemplate) {
      out += ch;
      if (ch === "$" && next === "{") {
        out += next;
        i += 2;
        let depth = 1;
        while (i < len && depth > 0) {
          const c = code[i];
          const n = code[i + 1];
          if (c === "/" && n === "/") {
            i += 2;
            while (i < len && code[i] !== "\n") i++;
            continue;
          }
          if (c === "/" && n === "*") {
            i += 2;
            while (i < len && !(code[i] === "*" && code[i + 1] === "/")) i++;
            i += 2;
            continue;
          }
          if (c === '"' || c === "'") {
            const quote = c;
            i++;
            while (i < len) {
              const cc = code[i];
              if (cc === "\\") {
                i += 2;
                continue;
              }
              if (cc === quote) {
                i++;
                break;
              }
              i++;
            }
            continue;
          }
          if (c === "`") {
            i++;
            while (i < len) {
              const cc = code[i];
              if (cc === "\\") {
                i += 2;
                continue;
              }
              if (cc === "`") {
                i++;
                break;
              }
              i++;
            }
            continue;
          }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          out += c;
          i++;
        }
        continue;
      }
      if (ch === "`") {
        inTemplate = false;
      }
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function processFile(relPath) {
  const p = path.join(__dirname, "..", relPath);
  try {
    const code = fs.readFileSync(p, "utf8");
    const stripped = stripComments(code);
    fs.writeFileSync(p, stripped, "utf8");
    console.log("Stripped comments:", relPath);
  } catch (err) {
    console.error("Failed:", relPath, err.message || err);
  }
}

for (const f of files) processFile(f);

console.log("Done.");
