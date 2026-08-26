import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve("pt_br.lang");
const output = path.resolve("dist");

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? files(target) : entry.name.endsWith(".jsonc") ? [target] : [];
  }).sort();
}

function parse(file) {
  const source = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return vm.runInNewContext(`(${source})`, Object.create(null), { filename: file, timeout: 1_000 });
}

function flatten(value, prefix = "", result = {}) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, result);
    }
  } else if (prefix) {
    result[prefix] = value;
  }
  return result;
}

function messages(...directories) {
  const result = {};
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const file of files(directory)) Object.assign(result, flatten(parse(file)));
  }
  const blocked = /(^|\.)(replay|recipe-manager|packet-area|mail|custom-entity|chunk-backup|combat-log|visual)(\.|$)/i;
  return Object.fromEntries(Object.entries(result).filter(([key]) => !blocked.test(key)));
}

function write(name, messageMap) {
  const bundle = { pt_br: { key: "pt_br", messageMap } };
  fs.writeFileSync(path.join(output, `${name}.json`), `${JSON.stringify(bundle)}\n`, "utf8");
}

fs.mkdirSync(output, { recursive: true });
const globalDirectory = path.join(root, "global");
const globalMessages = messages(globalDirectory);

write("global", globalMessages);
for (const alias of ["auth", "lobby", "proxy"]) write(alias, globalMessages);

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "global") continue;
  write(entry.name, { ...globalMessages, ...messages(path.join(root, entry.name)) });
}

console.log(`Built ${fs.readdirSync(output).length} locale bundles.`);
