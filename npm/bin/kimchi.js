#!/usr/bin/env node
/**
 * kimchi.js — Thin Node.js wrapper that spawns the Kimchi binary.
 *
 * This is the `bin` entry point in package.npm.json. It:
 *   1. Resolves the platform-specific binary (downloaded by postinstall.js)
 *   2. Spawns it with all passed arguments
 *   3. Forwards stdin/stdout/stderr
 *   4. Exits with the same code as the binary
 *
 * Design:
 *   - Follows the esbuild / turbo / playwright wrapper pattern
 *   - Works when called via `npx` (which runs in a temp directory)
 *   - Falls back to a system-installed `kimchi` if the downloaded binary
 *     is missing (e.g., postinstall was skipped with --ignore-scripts)
 */

"use strict";

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const platforms = require("./platforms.json");

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Returns the path to the Kimchi binary to run.
 *
 * Resolution order:
 *   1. KIMCHI_BIN_PATH env var (explicit override)
 *   2. The downloaded binary in vendor/<platform-key>/bin/kimchi
 *   3. A system-installed `kimchi` on PATH (fallback)
 *
 * @param {{ platform?: string, arch?: string, existsSync?: Function }} [opts]
 * @returns {string|null} — path to the binary, or null if not found
 */
function resolveBinaryPath(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const exists = opts.existsSync ?? fs.existsSync;

  // 1. Explicit override
  const envBin = process.env.KIMCHI_BIN_PATH;
  if (envBin && exists(envBin)) return envBin;

  // 2. Downloaded binary in vendor/
  const key = `${platform}-${arch}`;
  const entry = platforms[key];
  if (entry) {
    const vendorDir = path.join(__dirname, "..", "vendor", key);
    const binName = platform === "win32" ? "kimchi.exe" : "kimchi";
    const binaryPath = path.join(vendorDir, "bin", binName);
    if (exists(binaryPath)) return binaryPath;
  }

  // 3. Fallback: system-installed kimchi (on PATH)
  // We return the string "kimchi" so spawn() searches PATH.
  // The caller should check if it actually exists before spawning.
  return null;
}

// ---------------------------------------------------------------------------
// Main spawn logic
// ---------------------------------------------------------------------------

/**
 * Spawns the Kimchi binary with the given arguments, forwarding stdio.
 *
 * @param {string[]} args — arguments to pass to the binary
 * @param {{ spawnImpl?: Function, binaryPath?: string|null }} [opts]
 * @returns {Promise<number>} — exit code
 */
function runKimchi(args, opts = {}) {
  const spawnImpl = opts.spawnImpl ?? spawn;

  let binaryPath = opts.binaryPath !== undefined ? opts.binaryPath : resolveBinaryPath();

  if (!binaryPath) {
    // Fallback to system kimchi on PATH
    binaryPath = "kimchi";
    console.warn(
      "[kimchi] Downloaded binary not found. Falling back to system 'kimchi' on PATH.\n" +
        "[kimchi] If kimchi is not installed, run: npm rebuild @getkimchi/kimchi\n" +
        "[kimchi] Or install manually: https://github.com/getkimchi/kimchi#install"
    );
  }

  return new Promise((resolve) => {
    const child = spawnImpl(binaryPath, args, {
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("close", (code, signal) => {
      // If the child was killed by a signal, return 128 + signal number
      // (standard Unix convention). This prevents masking crashes as success.
      if (signal) {
        const signalNum = os.constants.signals[signal];
        resolve(signalNum ? 128 + signalNum : 1);
      } else {
        resolve(code ?? 0);
      }
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        console.error(
          `[kimchi] Binary not found: ${binaryPath}\n` +
            `[kimchi] Run: npm rebuild @getkimchi/kimchi\n` +
            `[kimchi] Or install manually: https://github.com/getkimchi/kimchi#install`
        );
      } else {
        console.error(`[kimchi] Failed to launch binary: ${err.message}`);
      }
      resolve(1);
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  runKimchi(args).then((code) => process.exit(code));
}

module.exports = { resolveBinaryPath, runKimchi };
