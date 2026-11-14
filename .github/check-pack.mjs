import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tgz = process.argv[2];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const entries = execFileSync("tar", ["tzf", tgz], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map((entry) => entry.replace(/^package\//, ""));

const toRegExp = (glob) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}$`);

const exportTargets = (value) =>
  typeof value === "string"
    ? [value]
    : Object.values(value ?? {}).flatMap(exportTargets);

const required = [
  "package.json",
  pkg.main,
  pkg.types,
  ...(pkg.files ?? []),
  ...exportTargets(pkg.exports),
]
  .filter(Boolean)
  .map((path) => path.replace(/^\.\//, ""));

const missing = [...new Set(required)].filter((path) => {
  const pattern = toRegExp(path);
  return !entries.some((entry) => pattern.test(entry) || entry.startsWith(`${path}/`));
});

if (missing.length > 0) {
  console.error(`::error::${tgz} is missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`${tgz}: ${entries.length} files, ${new Set(required).size} required paths present`);
