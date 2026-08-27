import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const sourceRoot = path.resolve(process.argv[2] ?? "..");
const localeRoot = path.resolve("pt_br.lang");

function walk(directory, accept) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if ([".git", ".gradle", "build"].includes(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target, accept) : accept(target) ? [target] : [];
  });
}

function flatten(value, prefix = "", result = new Set()) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, result);
    }
  } else if (prefix) {
    result.add(prefix);
  }
  return result;
}

function stripComments(source, extension) {
  if (extension === ".java") {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  if ([".yml", ".yaml"].includes(extension)) {
    return source.replace(/^\s*#.*$/gm, "");
  }
  return source;
}

const defined = new Set();
for (const file of walk(localeRoot, file => file.endsWith(".jsonc"))) {
  const value = vm.runInNewContext(`(${fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")})`);
  for (const key of flatten(value)) defined.add(key);
}

const references = new Map();
function reference(key, file) {
  if (!key || key.endsWith(".")) return;
  if (!references.has(key)) references.set(key, new Set());
  references.get(key).add(path.relative(sourceRoot, file).replaceAll(String.fromCharCode(92), "/"));
}

const sourceFiles = walk(sourceRoot, file => /\.(java|json|ya?ml)$/.test(file));
for (const file of sourceFiles) {
  const source = stripComments(fs.readFileSync(file, "utf8"), path.extname(file));
  const expression = /["'](plugins\.[a-zA-Z0-9_.-]+)["']/g;
  for (const match of source.matchAll(expression)) {
    reference(match[1], file);
  }
}

const javaClasses = new Map();
const parentByChild = new Map();
for (const file of sourceFiles.filter(file => file.endsWith(".java"))) {
  const source = stripComments(fs.readFileSync(file, "utf8"), ".java");
  const className = source.match(/\bclass\s+(\w+)/)?.[1];
  if (!className) continue;
  const key = source.match(/\bsetKey\(\s*"([^"]+)"\s*\)/)?.[1];
  const prefix = source.match(/\bsetPrefixLangKey\(\s*"([^"]+)"\s*\)/)?.[1];
  javaClasses.set(className, { file, source, key, prefix });
  for (const child of source.matchAll(/\bregisterSubCommand\(\s*new\s+(\w+)\s*\(/g)) {
    parentByChild.set(child[1], className);
  }
}

const baseCache = new Map();
function commandBase(className, seen = new Set()) {
  if (baseCache.has(className)) return baseCache.get(className);
  if (seen.has(className)) return undefined;
  seen.add(className);
  const command = javaClasses.get(className);
  if (!command?.key) return undefined;
  const parent = parentByChild.get(className);
  const parentBase = parent ? commandBase(parent, seen) : undefined;
  const base = parentBase
    ? `${parentBase}.${command.key}`
    : `${command.prefix ?? "commands"}.${command.key}`;
  baseCache.set(className, base);
  return base;
}

for (const [className, command] of javaClasses) {
  const base = commandBase(className);
  if (!base?.startsWith("plugins.")) continue;
  for (const match of command.source.matchAll(/\bgetLangKey\(\)\s*\+\s*"(\.[a-zA-Z0-9_.-]+)"/g)) {
    reference(`${base}${match[1]}`, command.file);
  }
  for (const match of command.source.matchAll(/\bmessageKey\(\s*"([a-zA-Z0-9_.-]+)"\s*\)/g)) {
    reference(`${base}.message.${match[1]}`, command.file);
  }
  for (const match of command.source.matchAll(/\bregisterArgument\(\s*new\s+\w*Argument\s*\(\s*"([a-zA-Z0-9_.-]+)"/g)) {
    reference(`${base}.arguments.${match[1]}.name`, command.file);
    reference(`${base}.arguments.${match[1]}.description`, command.file);
  }
}

const missing = [...references].filter(([key]) =>
  !defined.has(key) && ![...defined].some(candidate => candidate.startsWith(`${key}.`))
).sort(([first], [second]) => first.localeCompare(second));

for (const [key, files] of missing) {
  console.log(`${key}\t${[...files].join(",")}`);
}
console.error(`Checked ${references.size} code keys; ${missing.length} missing.`);
process.exitCode = missing.length ? 1 : 0;
