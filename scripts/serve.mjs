#!/usr/bin/env node
/** Static server for the built site (after postbuild nav injection). */
import http from "node:http"
import path from "node:path"
import handler from "serve-handler"

const PUBLIC = path.resolve(import.meta.dirname, "..", "public")
http
  .createServer((req, res) => handler(req, res, { public: PUBLIC, cleanUrls: true }))
  .listen(8080, () => console.log("Serving public/ at http://localhost:8080"))
