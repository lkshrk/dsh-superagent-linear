import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tgz = process.argv[2];
if (!tgz) {
  console.error("::error::usage: node .github/check-pack.mjs <tarball>");
  process.exit(2);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const entries = execFileSync("tar", ["tzf", tgz], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map((entry) => entry.replace(/^package\//, ""));

const globToRegExp = (glob) => {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
};

const normalize = (path) => path.replace(/^\.\//, "").replace(/\/+$/, "");

const present = (path) => {
  const pattern = globToRegExp(path);
  return entries.some((entry) => pattern.test(entry) || entry.startsWith(`${path}/`));
};

const exportTargets = (value) =>
  typeof value === "string" ? [value] : Object.values(value ?? {}).flatMap(exportTargets);

const required = [
  "package.json",
  pkg.types,
  ...(pkg.files ?? []).filter((path) => !path.startsWith("!")),
  ...exportTargets(pkg.exports),
]
  .filter(Boolean)
  .map(normalize);

const missing = [...new Set(required)].filter((path) => !present(path));

if (pkg.main) {
  const main = normalize(pkg.main);
  if (![main, `${main}.js`, `${main}/index.js`].some((path) => entries.includes(path))) {
    missing.push(main);
  }
}

if (missing.length > 0) {
  console.error(`::error::${tgz} is missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`${tgz}: ${entries.length} files, ${new Set(required).size + (pkg.main ? 1 : 0)} required paths present`);
