#!/usr/bin/env node
// Static checks for the Watch Sync extension. No dependencies.
//   node .github/scripts/check-extension.mjs
// 1. `node --check` (syntax only) on every extension/*.js
// 2. manifest.json: valid JSON, MV3 fields Chrome requires, valid match
//    patterns, and every file it points at exists
// 3. extension/*.html: scripts are local files that exist (MV3 pages can't
//    load remote or inline scripts)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ext = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extension");
const errors = [];
const fail = msg => errors.push(msg);
const has = rel => typeof rel === "string" && rel !== "" && existsSync(join(ext, rel));
const files = readdirSync(ext);

// ---------------------------------------------------------------- 1. syntax
const scripts = files.filter(f => f.endsWith(".js")).sort();
if (!scripts.length) fail("no .js files found in extension/");
for (const f of scripts) {
  try {
    execFileSync(process.execPath, ["--check", join(ext, f)], { stdio: "pipe" });
  } catch (e) {
    fail(`extension/${f}: syntax error\n${String(e.stderr || e.message).trim()}`);
  }
}

// -------------------------------------------------------------- 2. manifest
let m = null;
try {
  m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
} catch (e) {
  fail(`extension/manifest.json: ${e.message}`);
}

// https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
const MATCH = /^(<all_urls>|(\*|https?|wss?|ftp|file):\/\/(\*|(\*\.)?[^/*:]+(:(\*|\d+))?)?\/.*)$/;
const str = v => typeof v === "string" && v.trim() !== "";

if (m !== null) {
  const bad = msg => fail(`extension/manifest.json: ${msg}`);
  if (typeof m !== "object" || Array.isArray(m)) bad("top level must be an object");
  else {
    if (m.manifest_version !== 3) bad(`manifest_version must be 3 (got ${JSON.stringify(m.manifest_version)})`);
    if (!str(m.name)) bad("name is required");
    else if (m.name.length > 75) bad("name is longer than 75 characters");
    if (m.description != null && (!str(m.description) || m.description.length > 132)) bad("description must be a string of at most 132 characters");
    const parts = str(m.version) ? m.version.split(".") : [];
    if (parts.length < 1 || parts.length > 4 || !parts.every(p => /^(0|[1-9]\d*)$/.test(p) && +p <= 65535))
      bad(`version must be 1-4 dot-separated integers 0-65535 (got ${JSON.stringify(m.version)})`);

    for (const key of ["permissions", "host_permissions", "optional_permissions"]) {
      if (m[key] == null) continue;
      if (!Array.isArray(m[key]) || !m[key].every(str)) bad(`${key} must be an array of strings`);
    }
    for (const p of Array.isArray(m.host_permissions) ? m.host_permissions : [])
      if (str(p) && !MATCH.test(p)) bad(`host_permissions: invalid match pattern ${JSON.stringify(p)}`);

    if (m.background != null) {
      if (!has(m.background.service_worker)) bad(`background.service_worker not found: ${JSON.stringify(m.background.service_worker)}`);
    }
    if (m.action?.default_popup != null && !has(m.action.default_popup)) bad(`action.default_popup not found: ${JSON.stringify(m.action.default_popup)}`);
    for (const [size, icon] of Object.entries(m.icons ?? {}))
      if (!has(icon)) bad(`icons.${size} not found: ${JSON.stringify(icon)}`);

    if (m.content_scripts != null && !Array.isArray(m.content_scripts)) bad("content_scripts must be an array");
    (Array.isArray(m.content_scripts) ? m.content_scripts : []).forEach((cs, i) => {
      const at = `content_scripts[${i}]`;
      if (!Array.isArray(cs.matches) || !cs.matches.length) bad(`${at}.matches must be a non-empty array`);
      else for (const p of cs.matches) if (!str(p) || !MATCH.test(p)) bad(`${at}.matches: invalid match pattern ${JSON.stringify(p)}`);
      for (const key of ["js", "css"]) {
        if (cs[key] == null) continue;
        if (!Array.isArray(cs[key])) { bad(`${at}.${key} must be an array`); continue; }
        for (const f of cs[key]) if (!has(f)) bad(`${at}.${key} file not found: ${JSON.stringify(f)}`);
      }
      if (!cs.js?.length && !cs.css?.length) bad(`${at} lists no js or css`);
      if (cs.run_at != null && !["document_start", "document_end", "document_idle"].includes(cs.run_at)) bad(`${at}.run_at is invalid: ${JSON.stringify(cs.run_at)}`);
      if (cs.world != null && !["ISOLATED", "MAIN"].includes(cs.world)) bad(`${at}.world is invalid: ${JSON.stringify(cs.world)}`);
    });
  }
}

// ----------------------------------------------------------------- 3. pages
for (const f of files.filter(f => f.endsWith(".html")).sort()) {
  const html = readFileSync(join(ext, f), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!src) { if (body.trim()) fail(`extension/${f}: inline <script> is blocked by the MV3 content security policy`); continue; }
    const url = src[1] ?? src[2] ?? src[3];
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(url)) fail(`extension/${f}: remote script ${url} is blocked by the MV3 content security policy`);
    else if (!has(url.split(/[?#]/)[0])) fail(`extension/${f}: script not found: ${url}`);
  }
}

// ------------------------------------------------------------------ report
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n${errors.length} problem${errors.length === 1 ? "" : "s"} found.`);
  process.exit(1);
}
console.log(`✓ ${scripts.length} scripts pass node --check: ${scripts.join(", ")}`);
console.log("✓ manifest.json is valid and every file it references exists");
