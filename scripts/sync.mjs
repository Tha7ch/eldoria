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
    "WIKI.md",
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
  const sectionRe = /^##\s+(Leadership|Known Members|Associates)\s*$/
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
// pre-rendered texture tiles (CSS feTurbulence hangs renderers)
fs.mkdirSync(path.join(OUT, "textures"), { recursive: true })
const noiseSvg = (freq, oct, r, g, b, alpha) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${oct}"/><feColorMatrix values="0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 0 0 0 ${alpha} 0"/></filter><rect width="256" height="256" filter="url(%23n)"/></svg>`.replace(
      "%23",
      "#",
    ),
  )
await sharp(noiseSvg(0.75, 3, 0.42, 0.34, 0.18, 0.14)).png().toFile(path.join(OUT, "textures", "parchment.png"))
await sharp(noiseSvg(0.5, 4, 0.55, 0.55, 0.65, 0.1)).png().toFile(path.join(OUT, "textures", "stone.png"))

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

// ------------------------------------------------------- landing page helpers

const FLOURISH = `<div class="flourish">⸙ ❦ ⸙</div>`
const sectionHead = (t) => `<div class="ornate-head">⸻ ${t} ⸻</div>`

// strip markdown/wikilinks for plain-text snippets
const plain = (s) =>
  s
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[*_`#>]/g, "")
    .trim()

// first sentence of the Overview (or first paragraph) of a note
function firstLine(n, max = 130) {
  const m = n.body.match(/##\s+Overview\s*\r?\n+([^\n#][^\n]*)/)
  let text = plain(m ? m[1] : n.body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) || "")
  const dot = text.indexOf(". ")
  if (dot > 30) text = text.slice(0, dot + 1)
  if (text.length > max) text = text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…"
  return text
}

const pageLink = (n) => slugSegment(n.outRel)
const writeLanding = (file, title, body) =>
  fs.writeFileSync(path.join(OUT, file), `---\ntitle: "${title}"\n---\n\n${body}\n`)

// gold line-art icons (stroke = currentColor)
const ICONS = {
  swords: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4 L15 15 M15 15 l3 3 M13.5 16.5 L16.5 13.5 M18 18 l2 2"/><path d="M20 4 L9 15 M9 15 l-3 3 M10.5 16.5 L7.5 13.5 M6 18 l-2 2"/></svg>`,
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 5.5 C7 3.5 10.5 4.5 12 6.5 C13.5 4.5 17 3.5 21 5.5 V18 C17 16.5 13.5 17 12 19 C10.5 17 7 16.5 3 18 Z"/><path d="M12 6.5 V19"/></svg>`,
  tower: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M7 21 V8 M17 21 V8 M5 8 H19 M6 8 V5 H9 V7 H11 V5 H13 V7 H15 V5 H18 V8 M5 21 H19 M10 21 V15 H14 V21"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M12 3 L19 5.5 V11 C19 16 16.2 19.3 12 21 C7.8 19.3 5 16 5 11 V5.5 Z"/><path d="M12 7 V17 M8.5 10 H15.5"/></svg>`,
  rune: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M12 3 L14.2 9.8 L21 12 L14.2 14.2 L12 21 L9.8 14.2 L3 12 L9.8 9.8 Z"/><circle cx="12" cy="12" r="2.2"/></svg>`,
  scroll: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6 4 H19 C20.1 4 21 4.9 21 6 C21 7.1 20.1 8 19 8 H8 M6 4 C4.9 4 4 4.9 4 6 V18 C4 19.1 4.9 20 6 20 H17 C18.1 20 19 19.1 19 18 V8"/><path d="M8 11 H15 M8 14 H15 M8 17 H12"/></svg>`,
}

const SECTIONS = [
  { label: "Characters", file: null, page: "All Characters", icon: "swords", desc: "Heroes, nobles, gods, and demons" },
  { label: "Story", file: "Chronicles.md", page: "Chronicles", icon: "book", desc: "Sessions, side stories, and events" },
  { label: "Locations", file: "Atlas.md", page: "Atlas", icon: "tower", desc: "The realms and cities of Eldoria" },
  { label: "Organizations", file: "Heraldry.md", page: "Heraldry", icon: "shield", desc: "Houses, churches, and orders" },
  { label: "Powers", file: "Grimoire.md", page: "Grimoire", icon: "rune", desc: "Magic, gifts, and forbidden arts" },
  { label: "Appendices", file: "Appendices.md", page: "Appendices", icon: "scroll", desc: "Cosmology, rosters, and records" },
]

// ---------------------------------------------------------- story (Chronicles)

const sessionsOf = (c) =>
  [...notes.values()]
    .filter((n) => n.outRel.startsWith(`Story/Sessions/Campaign ${c}/`))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))

const sideStories = [...notes.values()]
  .filter((n) => n.outRel.startsWith("Story/Side Stories/"))
  .sort((a, b) => String(b.fm["date-added"] ?? "").localeCompare(String(a.fm["date-added"] ?? "")))

const events = [...notes.values()].filter((n) => n.outRel.startsWith("Story/Events/"))

const sessionCard = (n) => {
  const m = n.name.match(/Session\s*0*(\d+)\s*(?:\(([^)]*)\))?/i)
  const num = m ? m[1] : "?"
  const note = m && m[2] ? m[2] : ""
  return `<a class="shelf-card" href="${pageLink(n)}"><span class="shelf-num">Session ${num}</span><span class="shelf-note">${note}</span><span class="shelf-line">${firstLine(n, 110)}</span></a>`
}

const storyCard = (n) => {
  const subject = asList(n.fm.subjects).map(wikilinkName).find((s) => usedPortraits.has(s))
  const img = subject
    ? `portraits/${slugSegment(portraitOutName(subject))}`
    : "portraits/placeholder.svg"
  return `<a class="tale-card" href="${pageLink(n)}"><img src="${img}" alt="" loading="lazy"><span class="tale-title">${n.name.replace(/ - /, " — ")}</span>${n.fm.author ? `<span class="tale-author">by ${n.fm.author}</span>` : ""}</a>`
}

const eventRow = (n) => {
  const date = n.fm.date ? String(n.fm.date) : ""
  return `<div class="tl-row"><div class="tl-date">${date || "time unknown"}</div><div class="tl-dot"></div><div class="tl-body"><a href="${pageLink(n)}">${n.name}</a><span>${firstLine(n, 100)}</span></div></div>`
}

{
  const parts = []
  for (const c of [1, 2]) {
    const ss = sessionsOf(c)
    if (!ss.length) continue
    parts.push(sectionHead(`Campaign ${c} — Session Chronicles`))
    parts.push(`<div class="shelf">\n${ss.map(sessionCard).join("\n")}\n</div>`)
  }
  if (sideStories.length) {
    parts.push(sectionHead("Side Stories"))
    parts.push(`<div class="tale-shelf">\n${sideStories.map(storyCard).join("\n")}\n</div>`)
  }
  // chronological position: "N years/months before ..." -> years-ago value
  const yearsAgo = (n) => {
    const m = String(n.fm.date ?? "").match(/([\d.]+)\s*(year|month|day)s?\s+before/i)
    if (!m) return null
    const mult = { year: 1, month: 1 / 12, day: 1 / 365 }[m[2].toLowerCase()]
    return parseFloat(m[1]) * mult
  }
  const dated = events.filter((n) => yearsAgo(n) !== null).sort((a, b) => yearsAgo(b) - yearsAgo(a))
  const undated = events.filter((n) => yearsAgo(n) === null).sort(byName)
  if (events.length) {
    parts.push(sectionHead("Timeline of Events"))
    parts.push(`<div class="timeline">\n${[...dated, ...undated].map(eventRow).join("\n")}\n</div>`)
    parts.push(`<div class="tl-note">…more events of Eldoria's history are yet to be chronicled.</div>`)
  }
  writeLanding("Chronicles.md", "The Chronicles", parts.join("\n\n") + "\n\n" + FLOURISH)
}

// ------------------------------------------------------------ locations (Atlas)

{
  const locs = [...notes.values()].filter((n) => n.rel.startsWith("Locations/"))
  const children = new Map()
  for (const n of locs) {
    const parent = n.fm["part-of"] ? wikilinkName(n.fm["part-of"]) : null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(n)
  }
  const locByName = new Map(locs.map((n) => [n.name, n]))
  const renderLoc = (n, depth) => {
    const kids = (children.get(n.name) ?? []).sort(byName)
    return `<div class="gaz-entry" style="margin-left:${depth * 1.4}rem"><a href="${pageLink(n)}">${n.name}</a><span class="gaz-type">${n.fm.type ?? ""}</span><span class="gaz-line">${firstLine(n, 95)}</span></div>\n${kids.map((k) => renderLoc(k, depth + 1)).join("\n")}`
  }
  const countries = (children.get("Eldoria") ?? []).sort(byName)
  const parts = [`<div class="map-slot">A map of Eldoria has yet to be drawn.</div>`]
  const eldoria = locByName.get("Eldoria")
  if (eldoria)
    parts.push(`<div class="gaz-entry gaz-root"><a href="${pageLink(eldoria)}">Eldoria</a><span class="gaz-type">continent</span><span class="gaz-line">${firstLine(eldoria, 95)}</span></div>`)
  for (const c of countries) {
    parts.push(sectionHead(c.name))
    parts.push(renderLoc(c, 0))
  }
  const placed = new Set()
  const collect = (n) => {
    placed.add(n.name)
    for (const k of children.get(n.name) ?? []) collect(k)
  }
  if (eldoria) collect(eldoria)
  const others = locs.filter((n) => !placed.has(n.name)).sort(byName)
  if (others.length) {
    parts.push(sectionHead("Other & Fallen Realms"))
    parts.push(others.map((n) => renderLoc(n, 0)).join("\n"))
  }
  writeLanding("Atlas.md", "Atlas of Eldoria", parts.join("\n\n") + "\n\n" + FLOURISH)
}

// -------------------------------------------------------- organizations (Heraldry)

{
  const orgs = [...notes.values()].filter((n) => n.rel.startsWith("Organizations/"))
  const groupOf = (n) => {
    const t = String(n.fm.type ?? "")
    if (n.rel.includes("Noble Houses/")) return "Noble Houses"
    if (n.rel.includes("Churches/") || ["religious", "divine"].includes(t)) return "Churches & the Divine"
    if (["The Kingsguard", "King's Crown"].includes(n.name)) return "The Crown & the Realm"
    if (/demon/i.test(n.name) || ["secret", "criminal", "rebel", "guild"].includes(t)) return "Factions & Guilds"
    if (["kingdom", "military", "political"].includes(t)) return "The Crown & the Realm"
    return "Factions & Guilds"
  }
  const leaderOf = (n) => {
    const roles = orgRoles.get(n.name)
    if (!roles || !roles.size) return ""
    const [first] = roles.entries()
    return first ? `${first[0]}` : ""
  }
  const orgCard = (n) =>
    `<a class="her-card" href="${pageLink(n)}"><span class="her-name">${n.name}</span>${leaderOf(n) ? `<span class="her-head">${leaderOf(n)}</span>` : ""}<span class="her-line">${firstLine(n, 100)}</span></a>`
  const GROUP_ORDER = ["The Crown & the Realm", "Noble Houses", "Churches & the Divine", "Factions & Guilds"]
  const parts = []
  for (const g of GROUP_ORDER) {
    const members = orgs.filter((n) => groupOf(n) === g && n.name !== "The Great Houses").sort(byName)
    if (!members.length) continue
    parts.push(sectionHead(g))
    parts.push(`<div class="her-grid">\n${members.map(orgCard).join("\n")}\n</div>`)
  }
  writeLanding("Heraldry.md", "Heraldry & Orders", parts.join("\n\n") + "\n\n" + FLOURISH)
}

// ---------------------------------------------------------- powers (Grimoire)

{
  const powers = [...notes.values()].filter((n) => n.rel.startsWith("Power Systems/")).sort(byName)
  const rows = powers.map(
    (n) =>
      `<a class="scroll-row" href="${pageLink(n)}"><span class="scroll-name">${n.name}</span><span class="scroll-type">${n.fm.type ?? ""}</span><span class="scroll-line">${firstLine(n, 120)}</span></a>`,
  )
  writeLanding("Grimoire.md", "The Grimoire", `${rows.join("\n")}\n\n${FLOURISH}`)
}

// ------------------------------------------------------------------ appendices

{
  const misc = [...notes.values()].filter((n) => n.rel.startsWith("Misc Notes/")).sort(byName)
  const rows = misc.map(
    (n) =>
      `<a class="scroll-row" href="${pageLink(n)}"><span class="scroll-name">${n.name}</span><span class="scroll-line">${firstLine(n, 120)}</span></a>`,
  )
  writeLanding("Appendices.md", "Appendices", `${rows.join("\n")}\n\n${FLOURISH}`)
}

// ------------------------------------------------------------------ homepage

{
  const navCards = SECTIONS.map(
    (s) =>
      `<a class="nav-card" href="./${slugSegment(s.page)}"><span class="nav-icon">${ICONS[s.icon]}</span><span class="nav-card-title">${s.label}</span><span class="nav-card-desc">${s.desc}</span></a>`,
  ).join("\n")

  const party = pcsByCampaign(2)
  const partyCards = party
    .map(
      (ch) =>
        `<a class="party-card" href="${pageUrlByName(ch.name, 0)}"><img src="${portraitUrl(ch.name, 0)}" alt="${ch.name}" loading="lazy"><span>${ch.name.split(" ")[0]}</span></a>`,
    )
    .join("\n")

  const latest = []
  const s1 = sessionsOf(1)[0]
  const s2 = sessionsOf(2)[0]
  if (s1) latest.push({ n: s1, tag: "Campaign 1" })
  if (s2) latest.push({ n: s2, tag: "Campaign 2" })
  for (const st of sideStories.slice(0, 3)) latest.push({ n: st, tag: "Side Story" })
  const latestRows = latest
    .map(
      (l) =>
        `<a class="chron-row" href="${pageLink(l.n)}"><span class="chron-tag">${l.tag}</span><span class="chron-title">${l.n.name}</span></a>`,
    )
    .join("\n")

  writeLanding(
    "index.md",
    "The Eldoria Expanse",
    `<div class="home-banner">
<div class="home-glyph">❦</div>
<h1>The Eldoria Expanse</h1>
<div class="home-rule"></div>
<p>A chronicle of two campaigns across the realm of Eldoria — its heroes, gods, kingdoms, and the storms gathering over Brittania.</p>
</div>

<div class="nav-grid">
${navCards}
</div>

${sectionHead("The Current Party")}
<div class="party-sub">Campaign 2</div>

<div class="party-strip">
${partyCards}
</div>

${sectionHead("Latest Chronicles")}

<div class="chron-list">
${latestRows}
</div>

${FLOURISH}`,
  )
}

console.log(`Synced ${notes.size} pages, ${copied} images, ${usedPortraits.size} portraits.`)
const noPortrait = characters.filter((ch) => !usedPortraits.has(ch.name)).map((ch) => ch.name)
if (noPortrait.length) console.log(`No 4x5 portrait (placeholder used): ${noPortrait.join(", ")}`)
