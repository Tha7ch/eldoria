#!/usr/bin/env node
/**
 * Post-build: inject the manuscript top-nav into every emitted HTML page.
 * Links use per-page relative prefixes so the site works under any base path.
 */
import fs from "node:fs"
import path from "node:path"

const PUBLIC = path.resolve(import.meta.dirname, "..", "public")

const TABS = [
  ["Characters", "all-characters"],
  ["Story", "chronicles"],
  ["Locations", "atlas"],
  ["Organizations", "heraldry"],
  ["Powers", "grimoire"],
  ["Appendices", "appendices"],
]

function navHtml(prefix) {
  const links = TABS.map(([label, slug]) => `<a href="${prefix}${slug}">${label}</a>`).join("")
  return `<nav class="eld-nav"><a class="eld-title" href="${prefix}">The Eldoria Expanse</a><div class="eld-links">${links}</div><div class="eld-tools"></div></nav>`
}

function* htmlFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* htmlFiles(p)
    else if (e.name.endsWith(".html")) yield p
  }
}

let count = 0
for (const file of htmlFiles(PUBLIC)) {
  let html = fs.readFileSync(file, "utf8")
  if (html.includes("eld-nav")) continue
  const depth = path.relative(PUBLIC, file).split(path.sep).length - 1
  const prefix = depth === 0 ? "./" : "../".repeat(depth)
  html = html.replace(/(<body[^>]*>)/, `$1${navHtml(prefix)}`)
  fs.writeFileSync(file, html)
  count++
}
console.log(`Injected nav into ${count} pages.`)
