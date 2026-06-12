#!/usr/bin/env node
/**
 * Eldoria Expanse — vault → content sync.
 *
 * Copies the Obsidian vault into ./content, filtering DM-only material,
 * injecting character infoboxes, and generating the faction-grouped
 * Characters page and the homepage.
 *
 * Usage: node scripts/sync.mjs [--vault "path/to/vault"]
 */

import fs from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import sharp from "sharp"

const REPO = path.resolve(import.meta.dirname, "..")
const VAULT =
  process.argv.includes("--vault")
    ? process.argv[process.argv.indexOf("--vault") + 1]
    : "G:\\My Drive\\Dungeons and Dragons\\The Eldoria Expanse"
const OUT = path.join(REPO, "content")
const IMAGES_DIR = "Eldoria Images"

// ---------------------------------------------------------------- exclusions

const EXCLUDED_FILES = new Set(
  [
    "CLAUDE.md",
    "log.md",
    "index.md",
    "Misc Notes/Mysteries - Campaign 1.md",
    "Misc Notes/Mysteries - Campaign 2.md",
    "Misc Notes/Image Generation Guide.md",
    "Misc Notes/Image Registry.md",
    "Misc Notes/Tirian - Story Roadmap.md",
  ].map((p) => p.toLowerCase()),
)

const EXCLUDED_DIRS = new Set(
  ["Session Notes/Archive", ".obsidian", ".trash"].map((p) => p.toLowerCase()),
)

const STRIPPED_SECTIONS = [
  "Mysteries & DM Questions",
  "In the Doomed Future",
  "Unclear Attributions",
]

const CHARACTER_TYPES = new Set([
  "player-character",
  "character",
  "deity",
  "demon",
  "demon-general",
])

// ------------------------------------------------------------------- helpers

const slugSegment = (s) =>
  s
    .replace(/\.md$/i, "")
    .split("/")
    .map((seg) =>
      seg.replace(/\s/g, "-").replace(/&/g, "-and-").replace(/%/g, "-percent").replace(/[?#]/g, "").toLowerCase(),
    )
    .join("/")

const cleanName = (s) =>
  s
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

function walk(dir, base = "") {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(rel.toLowerCase())) continue
      out.push(...walk(path.join(dir, entry.name), rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

function parseNote(absPath) {
  const raw = fs.readFileSync(absPath, "utf8").replace(/^﻿/, "")
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  let fm = {}
  let body = raw
  if (m) {
    try {
      fm = parseYaml(m[1]) ?? {}
    } catch {
      fm = {}
    }
    body = raw.slice(m[0].length)
  }
  return { fm, body }
}

function stripSections(body) {
  const lines = body.split(/\r?\n/)
  const out = []
  let skipping = false
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const title = h[2].trim()
      skipping = h[1].length === 2 && STRIPPED_SECTIONS.some((s) => title.toLowerCase().startsWith(s.toLowerCase()))
    }
    if (!skipping) out.push(line)
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n")
}

// remap vault folders into the published "Story" section
function remapRel(rel) {
  if (rel.startsWith("Session Notes/")) return "Story/Sessions/" + rel.slice("Session Notes/".length)
  if (rel.startsWith("Side Stories/")) return "Story/Side Stories/" + rel.slice("Side Stories/".length)
  if (rel.startsWith("Events/")) return "Story/Events/" + rel.slice("Events/".length)
  return rel
}

const wikilinkName = (s) => {
  const m = String(s).match(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/)
  return m ? m[1].trim() : String(s).trim()
}

const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v])

// ------------------------------------------------------------ portrait index

const vaultImages = fs.existsSync(path.join(VAULT, IMAGES_DIR))
  ? fs.readdirSync(path.join(VAULT, IMAGES_DIR))
  : []

function findPortrait(name, aliases) {
  const candidates = [name, ...asList(aliases).map(String), name.split(" ")[0]]
  for (const cand of candidates) {
    const want = `${cand.toLowerCase()} (4x5 portrait)`
    const hit = vaultImages.find((f) => {
      const base = f.replace(/\.(png|jpe?g|webp)$/i, "").toLowerCase()
      return base === want
    })
    if (hit) return hit
  }
  return null
}

// --------------------------------------------------------------- scan vault

console.log(`Vault: ${VAULT}`)
const allFiles = walk(VAULT)
const mdFiles = allFiles.filter(
  (f) =>
    f.toLowerCase().endsWith(".md") &&
    !EXCLUDED_FILES.has(f.toLowerCase()) &&
    !f.toLowerCase().includes("desktop.ini"),
)

/** rel path -> { fm, body, name, type } */
const notes = new Map()
for (const rel of mdFiles) {
  const { fm, body } = parseNote(path.join(VAULT, rel))
  // the file name is the canonical full name (matches wikilink targets);
  // prefer it over a shorter frontmatter `name`
  const name = path.basename(rel, ".md")
  notes.set(rel, { fm, body, name, rel, outRel: remapRel(rel) })
}

// characters = everything with a character-ish type
const characters = [...notes.values()].filter((n) => CHARACTER_TYPES.has(n.fm.type))

// ------------------------------------------------- organization role parsing

/** org page name -> Map(member name -> role) */
const orgRoles = new Map()
/** org page name -> rel path */
const orgPages = new Map()
for (const n of notes.values()) {
  if (!n.rel.startsWith("Organizations/")) continue
  orgPages.set(n.name, n.rel)
  const roles = new Map()
  const sectionRe = /^##\s+(Leadership|Known Members)\s*$/
  let inSection = false
  for (const line of n.body.split(/\r?\n/)) {
    if (/^##\s/.test(line)) inSection = sectionRe.test(line.trim())
    if (!inSection) continue
    const m = line.match(/^-\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*[—–-]\s*(.+)$/)
    if (m) {
      const member = m[1].trim()
      // first listed role wins (Leadership comes before Known Members)
      if (!roles.has(member)) {
        // keep subtitles short: cut at the first ; and strip markdown
        let role = m[2].trim().replace(/\*/g, "").split(";")[0].trim()
        role = role.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1")
        if (role.length > 70) role = role.slice(0, 67).replace(/\s+\S*$/, "") + "…"
        roles.set(member, role)
      }
    }
  }
  orgRoles.set(n.name, roles)
}

// ------------------------------------------------------------- write content

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const referencedImages = new Set()
const usedPortraits = new Map() // character name -> portraits/<file>

for (const ch of characters) {
  const p = findPortrait(ch.name, ch.fm.aliases)
  if (p) usedPortraits.set(ch.name, p)
}

const ext = (f) => path.extname(f).toLowerCase()
const isConvertible = (f) => [".png", ".jpg", ".jpeg", ".webp"].includes(ext(f))
// published filename: convertible images become resized .webp
const webName = (f) => (isConvertible(f) ? f.replace(/\.(png|jpe?g|webp)$/i, ".webp") : f)
const portraitOutName = (name) => `${cleanName(name)}.webp`
const portraitUrl = (name, depth) =>
  usedPortraits.has(name)
    ? `${"../".repeat(depth)}portraits/${slugSegment(portraitOutName(name))}`
    : `${"../".repeat(depth)}portraits/placeholder.svg`

// roles lookup for a character within an org
const roleOf = (orgName, charName) => orgRoles.get(orgName)?.get(charName) ?? ""

function infoboxHtml(ch, depth) {
  const fm = ch.fm
  const rows = []
  const row = (label, value) => {
    if (value) rows.push(`<tr><th>${label}</th><td>${value}</td></tr>`)
  }
  const show = (v) => (v && String(v).toLowerCase() !== "unknown" ? String(v) : "")
  const aliases = asList(fm.aliases).filter((a) => a !== ch.name)
  if (fm.name && fm.name !== ch.name && !aliases.includes(fm.name)) aliases.unshift(fm.name)
  row("Aliases", aliases.join(", "))
  row("Race", show(fm.race))
  row("Age", show(fm.age))
  row("Height", show(fm.height))
  if (fm.status && String(fm.status).toLowerCase() !== "unknown") {
    const status = String(fm.status)
    const statusHtml = fm["spoiler-status"]
      ? `<span class="spoiler" tabindex="0" title="Click to reveal">${status}</span>`
      : status
    row("Status", statusHtml)
  }
  const affs = asList(fm.affiliation)
    .map(wikilinkName)
    .filter((a) => notes.size === 0 || true)
  if (affs.length) row("Affiliation", affs.map((a) => `<a href="${pageUrlByName(a, depth)}">${a}</a>`).filter(Boolean).join("<br>"))
  if (fm.player && !["you", "unknown"].includes(String(fm.player).toLowerCase())) row("Player", String(fm.player))
  const campaigns = asList(fm.campaign)
  if (campaigns.length) row("Campaign", campaigns.join(", "))

  return `<aside class="infobox">
<img src="${portraitUrl(ch.name, depth)}" alt="${ch.name}">
<div class="infobox-name">${ch.name}</div>
<table>${rows.join("")}</table>
</aside>\n\n`
}

/** name -> slug url (relative from a page at given depth) */
const nameToSlug = new Map()
for (const n of notes.values()) nameToSlug.set(n.name, slugSegment(n.outRel))
function pageUrlByName(name, depth) {
  const slug = nameToSlug.get(name)
  if (!slug) return "#"
  return "../".repeat(depth) + slug
}

const IMG_EMBED_RE = /!\[\[([^\]|]+?\.(?:png|jpe?g|webp|gif))(?:\|[^\]]*)?\]\]/gi

for (const n of notes.values()) {
  let body = stripSections(n.body)

  // collect referenced images and point embeds at the compressed .webp versions
  for (const m of body.matchAll(IMG_EMBED_RE)) referencedImages.add(m[1].trim())
  body = body.replace(IMG_EMBED_RE, (full, file) => {
    const renamed = webName(file.trim())
    return renamed === file.trim() ? full : full.replace(file, renamed)
  })

  const depth = n.outRel.split("/").length - 1
  const isCharacter = CHARACTER_TYPES.has(n.fm.type)

  if (isCharacter) {
    // drop the inline portrait embed that the infobox now displays
    const portrait = usedPortraits.get(n.name)
    if (portrait) {
      const pEsc = portrait.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      body = body.replace(new RegExp(`!\\[\\[${pEsc}(?:\\|[^\\]]*)?\\]\\]\\s*`, "i"), "")
    }
    body = infoboxHtml(n, depth) + body
  }

  // rebuild frontmatter with a proper title
  const fmOut = { ...n.fm }
  fmOut.title = n.name
  delete fmOut.name
  const yaml = Object.entries(fmOut)
    .map(([k, v]) => {
      if (Array.isArray(v))
        return v.length ? `${k}:\n${v.map((x) => `  - ${JSON.stringify(String(x))}`).join("\n")}` : null
      if (v === null || v === undefined || v === "") return null
      return `${k}: ${JSON.stringify(String(v))}`
    })
    .filter(Boolean)
    .join("\n")

  const outPath = path.join(OUT, n.outRel)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `---\n${yaml}\n---\n\n${body.trim()}\n`)
}

// ------------------------------------------------------------- copy images

fs.mkdirSync(path.join(OUT, IMAGES_DIR), { recursive: true })
let copied = 0
for (const img of referencedImages) {
  const base = path.basename(img)
  const src = path.join(VAULT, IMAGES_DIR, base)
  if (!fs.existsSync(src)) continue
  if (isConvertible(base)) {
    await sharp(src)
      .resize({ width: 1400, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(path.join(OUT, IMAGES_DIR, webName(base)))
  } else {
    fs.copyFileSync(src, path.join(OUT, IMAGES_DIR, base))
  }
  copied++
}

fs.mkdirSync(path.join(OUT, "portraits"), { recursive: true })
for (const [name, file] of usedPortraits) {
  await sharp(path.join(VAULT, IMAGES_DIR, file))
    .resize({ width: 600, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(path.join(OUT, "portraits", portraitOutName(name)))
}
fs.writeFileSync(
  path.join(OUT, "portraits", "placeholder.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#9a9a9a"/><circle cx="200" cy="190" r="80" fill="#bdbdbd"/><path d="M60 470 Q200 300 340 470 V500 H60 Z" fill="#bdbdbd"/></svg>`,
)

// ------------------------------------------------------ characters page gen

const card = (ch, role, fromDepth = 0) => {
  const url = pageUrlByName(ch.name, fromDepth)
  const img = portraitUrl(ch.name, fromDepth)
  return `<a class="char-card" href="${url}"><img src="${img}" alt="${ch.name}" loading="lazy"><div class="char-card-text"><div class="char-card-name">${ch.name}</div>${role ? `<div class="char-card-role">${role}</div>` : ""}</div></a>`
}

const grid = (cards) => `<div class="char-grid">\n${cards.join("\n")}\n</div>`
const banner = (title) => `<div class="faction-banner">${title}</div>`

const byName = (a, b) => a.name.localeCompare(b.name)

// membership: character whose affiliation contains org name, sorted by
// standing — the order they're listed on the org page (Leadership first,
// then Known Members), falling back to age (oldest first), then name
const numAge = (ch) => {
  const a = parseInt(ch.fm.age, 10)
  return Number.isFinite(a) ? a : -1
}
const membersOf = (orgName) => {
  const listing = [...(orgRoles.get(orgName)?.keys() ?? [])]
  const standing = (ch) => {
    const i = listing.indexOf(ch.name)
    return i === -1 ? Infinity : i
  }
  return characters
    .filter((ch) => asList(ch.fm.affiliation).map(wikilinkName).includes(orgName))
    .sort((a, b) => standing(a) - standing(b) || numAge(b) - numAge(a) || a.name.localeCompare(b.name))
}

const sections = []

// --- player characters
const pcs = characters.filter((ch) => ch.fm.type === "player-character")
const pcsByCampaign = (c) =>
  pcs
    .filter((ch) => asList(ch.fm.campaign).map(Number)[0] === c)
    .sort(byName)
const pcRole = (ch) =>
  ch.fm.player && !["you", "unknown"].includes(String(ch.fm.player).toLowerCase())
    ? `Played by ${ch.fm.player}`
    : ""
sections.push(`## Player Characters\n`)
for (const c of [1, 2]) {
  const group = pcsByCampaign(c)
  if (!group.length) continue
  sections.push(banner(`Campaign ${c}`))
  sections.push(grid(group.map((ch) => card(ch, pcRole(ch)))))
}

// --- faction groups
const FACTION_GROUPS = [
  {
    heading: "The Crown",
    orgs: ["The Kingsguard", "King's Crown"],
  },
  {
    heading: "Noble Houses",
    orgs: [...orgPages.keys()]
      .filter((o) => orgPages.get(o).startsWith("Organizations/Noble Houses/") && o !== "The Great Houses")
      .sort(),
  },
  {
    heading: "Churches",
    orgs: [...orgPages.keys()].filter((o) => orgPages.get(o).startsWith("Organizations/Churches/")).sort(),
  },
  {
    heading: "Independent Factions",
    orgs: ["The People's Liberation Front of Brittania", "Honest Hearts"],
  },
]

const inFaction = new Set()
for (const group of FACTION_GROUPS) {
  const parts = []
  for (const orgName of group.orgs) {
    const members = membersOf(orgName)
    if (!members.length) continue
    members.forEach((m) => inFaction.add(m.name))
    const orgUrl = pageUrlByName(orgName, 0)
    parts.push(banner(`<a href="${orgUrl}">${orgName}</a>`))
    parts.push(grid(members.map((ch) => card(ch, roleOf(orgName, ch.name)))))
  }
  if (parts.length) sections.push(`## ${group.heading}\n`, ...parts)
}

// --- pantheon
const gods = characters.filter((ch) => ch.fm.type === "deity").sort(byName)
const godRole = (ch) => {
  const m = ch.body.match(/God(?:dess)? of [^.\n]*/)
  return m ? m[0].trim() : ""
}
if (gods.length) {
  sections.push(`## The Pantheon\n`)
  sections.push(banner(`<a href="${pageUrlByName("Pantheon of Gods", 0)}">Pantheon of Gods</a>`))
  sections.push(grid(gods.map((ch) => card(ch, godRole(ch)))))
}

// --- demons
const DEMON_ORDER = ["Luciferus", "Null", "X", "Kronos"]
const demons = characters
  .filter((ch) => ["demon", "demon-general"].includes(ch.fm.type) || DEMON_ORDER.includes(ch.name))
  .sort((a, b) => {
    const ai = DEMON_ORDER.indexOf(a.name)
    const bi = DEMON_ORDER.indexOf(b.name)
    return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi) || a.name.localeCompare(b.name)
  })
demons.forEach((d) => inFaction.add(d.name))
if (demons.length) {
  sections.push(`## Demons\n`)
  sections.push(banner(`<a href="${pageUrlByName("The Twelve Demon Generals", 0)}">Demons & Demon Generals</a>`))
  sections.push(grid(demons.map((ch) => card(ch, roleOf("The Twelve Demon Generals", ch.name)))))
}

// --- unaffiliated (NPCs with no org affiliation; PCs already shown on top)
const unaffiliated = characters
  .filter(
    (ch) =>
      // NPCs with no faction, plus PCs not assigned to a campaign (e.g. future concepts)
      (ch.fm.type === "character" ||
        (ch.fm.type === "player-character" && asList(ch.fm.campaign).length === 0)) &&
      !inFaction.has(ch.name) &&
      !asList(ch.fm.affiliation).map(wikilinkName).some((a) => orgPages.has(a)),
  )
  .sort(byName)
if (unaffiliated.length) {
  sections.push(`## Unaffiliated & Others\n`)
  sections.push(grid(unaffiliated.map((ch) => card(ch, ""))))
}

fs.writeFileSync(
  path.join(OUT, "All Characters.md"),
  `---
title: "Characters"
---

All known figures of the Eldoria Expanse, grouped by faction. Characters may appear under every faction they belong to.

${sections.join("\n\n")}
`,
)

// ------------------------------------------------------------------ homepage

const navCard = (title, slug, desc) =>
  `<a class="nav-card" href="./${slugSegment(slug)}"><div class="nav-card-title">${title}</div><div class="nav-card-desc">${desc}</div></a>`

fs.writeFileSync(
  path.join(OUT, "index.md"),
  `---
title: "The Eldoria Expanse"
---

<div class="home-banner">
<h1>The Eldoria Expanse</h1>
<p>A chronicle of two campaigns across the realm of Eldoria — its heroes, gods, kingdoms, and the storms gathering over Brittania.</p>
</div>

<div class="nav-grid">
${navCard("Characters", "All Characters", "Every hero, noble, god, and demon — grouped by faction")}
${navCard("Story", "Story", "Session chronicles, side stories, and major events")}
${navCard("Locations", "Locations", "The continents, kingdoms, and cities of Eldoria")}
${navCard("Organizations", "Organizations", "The Kingsguard, noble houses, churches, and more")}
${navCard("Power Systems", "Power-Systems", "Magic, divine gifts, and forbidden arts")}
</div>

*This wiki is maintained from the players' perspective — some details may be unconfirmed rumors. Use the search (top of the sidebar) to find anything.*
`,
)

console.log(`Synced ${notes.size} pages, ${copied} images, ${usedPortraits.size} portraits.`)
const noPortrait = characters.filter((ch) => !usedPortraits.has(ch.name)).map((ch) => ch.name)
if (noPortrait.length) console.log(`No 4x5 portrait (placeholder used): ${noPortrait.join(", ")}`)
