#!/usr/bin/env node
/**
 * Inlines src/ into dist/geocoder.html - one file, opened by double-clicking it.
 *
 *   node scripts/build-app.mjs
 *
 * The modules are concatenated into a single classic script rather than kept as ES modules,
 * because on a file:// URL a module script cannot import a sibling file: the browser treats
 * that as a cross-origin fetch and blocks it. Concatenating removes the imports entirely, so
 * the page works with no server at all. That is the whole point of this build - if it ever
 * needs a bundler, something has gone wrong with the design.
 *
 * The place data is NOT inlined. It is 244 MB, and only the countries a given file names are
 * ever loaded; those arrive as script tags from the data folder beside this HTML.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (name) => readFileSync(join(root, "src", name), "utf8");

/** Dependency order, since concatenation has no idea what depends on what. */
const MODULES = ["fold.js", "gazetteer.js", "locate.js", "table.js", "app.js"];

function flatten(code) {
    return code
        .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?[ \t]*$/gm, "")
        .replace(/^export\s+(function|const|let|class)\b/gm, "$1");
}

const script = MODULES
    .map((name) => "// ---- " + name + " " + "-".repeat(Math.max(0, 60 - name.length)) + "\n" + flatten(src(name)).trim())
    .join("\n\n");

const html = src("shell.html")
    .replace("/*STYLE*/", () => "\n" + src("style.css").trim() + "\n")
    .replace("/*APP*/", () => "\n" + script + "\n");

mkdirSync(join(root, "dist"), { recursive: true });
const target = join(root, "dist", "geocoder.html");
writeFileSync(target, html);
console.log("  " + target);
console.log("  " + (html.length / 1024).toFixed(0) + " KB, " + MODULES.length + " modules inlined");
