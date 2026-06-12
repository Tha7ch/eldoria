#!/usr/bin/env node
/** One-command publish: sync vault -> commit -> push (triggers Pages deploy). */
import { execSync } from "node:child_process"

const run = (cmd) => execSync(cmd, { stdio: "inherit", cwd: new URL("..", import.meta.url) })

run("node scripts/sync.mjs")
run("git add -A")
try {
  run(`git commit -m "Publish wiki update (${new Date().toISOString().slice(0, 10)})"`)
} catch {
  console.log("Nothing new to publish — content unchanged.")
  process.exit(0)
}
run("git push origin main")
console.log("\nPushed. GitHub Pages will rebuild the site in ~2 minutes.")
