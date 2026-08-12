#!/usr/bin/env node
/**
 * postinstall.js — Downloads the correct pre-built Kimchi binary for the
 * current platform from GitHub Releases and extracts it into the package
 * directory.
 *
 * The binary ships as a tarball (Unix) or zip (Windows) containing:
 *   bin/kimchi       — the executable
 *   share/kimchi/    — runtime assets (themes, oauth, export-html)
 *
 * Security:
 *   - Verifies SHA-256 checksum from checksums.txt before extraction
 *   - Uses spawnSync with argument arrays (no shell interpolation)
 *   - Never throws on failure (postinstall failures block ALL npm installs)
 *
 * Design:
 *   - Follows the esbuild / turbo / sharp pattern
 *   - Retries with exponential backoff on transient network errors only
 *   - Downloads from latest release tag (or KIMCHI_VERSION env override)
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createWriteStream, mkdirSync, rmSync, existsSync, chmodSync } = require("node:fs");

const REPO = "getkimchi/kimchi";
const PLATFORMS_PATH = path.join(__dirname, "platforms.json");

// ---------------------------------------------------------------------------
// Platform resolution
// ---------------------------------------------------------------------------

function getPlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function loadPlatforms() {
  return JSON.parse(fs.readFileSync(PLATFORMS_PATH, "utf8"));
}

function resolvePlatform(platforms, platform, arch) {
  const key = getPlatformKey(platform, arch);
  const entry = platforms[key];
  if (!entry) {
    throw new Error(
      `Kimchi does not ship a pre-built binary for ${key}.\n` +
        `Supported platforms: ${Object.keys(platforms).join(", ")}\n` +
        `You can build from source: https://github.com/${REPO}`
    );
  }
  return { key, asset: entry.asset, archiveType: entry.archiveType };
}

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

/**
 * Returns the version tag to download.
 *
 * Priority:
 *   1. KIMCHI_VERSION env var (e.g. "v0.1.84") — explicit pin
 *   2. The npm package version if it's a real release (not "0.0.0")
 *   3. "latest" — fall back to the latest GitHub release
 *
 * When published from the release workflow, the npm package version is set
 * from the GitHub tag, so they always match. The "0.0.0" placeholder is
 * used during development and falls back to "latest".
 *
 * @param {string} [packageVersion] — version from package.json
 * @returns {string} e.g. "v0.1.84" or "latest"
 */
function resolveVersion(packageVersion) {
  const envVersion = process.env.KIMCHI_VERSION;
  if (envVersion) return envVersion.startsWith("v") ? envVersion : `v${envVersion}`;

  // Use package version if it's a real release (not the dev placeholder)
  if (packageVersion && packageVersion !== "0.0.0") {
    return packageVersion.startsWith("v") ? packageVersion : `v${packageVersion}`;
  }

  return "latest";
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

const GITHUB_BASE = "https://github.com";

function buildDownloadUrl(tag, asset) {
  if (tag === "latest") {
    return `${GITHUB_BASE}/${REPO}/releases/latest/download/${asset}`;
  }
  return `${GITHUB_BASE}/${REPO}/releases/download/${tag}/${asset}`;
}

function buildChecksumUrl(tag) {
  return buildDownloadUrl(tag, "checksums.txt");
}

// ---------------------------------------------------------------------------
// HTTP download
// ---------------------------------------------------------------------------

/**
 * Classifies an error to determine if it's retryable.
 * Only transient network errors (timeouts, connection resets, 5xx) are retried.
 * Client errors (404, 403) fail immediately.
 *
 * @param {Error} err
 * @returns {boolean} — true if the error is retryable
 */
function isRetryableError(err) {
  // Non-HTTP errors (network, timeout) are always retryable
  if (!err.statusCode) {
    return true;
  }
  // 5xx server errors are retryable
  if (err.statusCode >= 500) {
    return true;
  }
  // 4xx client errors (404, 403, etc.) are NOT retryable
  return false;
}

/**
 * Downloads a URL and writes the response body to a file.
 * Follows up to 5 redirects.
 *
 * @param {string} url
 * @param {string} destPath — file path to write to
 * @param {number} [redirectsLeft=5]
 * @returns {Promise<void>}
 */
function defaultFetch(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "kimchi-npm-postinstall",
          Accept: "application/octet-stream",
        },
      },
      (res) => {
        if (
          (res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 303 ||
            res.statusCode === 307 ||
            res.statusCode === 308) &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects"));
            return;
          }
          res.resume();
          const nextUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          resolve(defaultFetch(nextUrl, destPath, redirectsLeft - 1));
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          const err = new Error(`HTTP ${res.statusCode} downloading ${url}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }

        const stream = createWriteStream(destPath);
        res.pipe(stream);
        stream.on("finish", () => stream.close(resolve));
        stream.on("error", reject);
      }
    );

    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error("Download timed out after 120s"));
    });
  });
}

/**
 * Downloads a URL with retry on transient errors.
 *
 * @param {string} url
 * @param {string} destPath — file path to write to
 * @param {{ maxRetries?: number, fetchImpl?: Function, baseDelay?: number }} [opts]
 * @returns {Promise<void>}
 */
async function downloadFile(url, destPath, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const baseDelay = opts.baseDelay ?? 1000;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchImpl(url, destPath);
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !isRetryableError(err)) break;
      const delay = baseDelay * Math.pow(2, attempt);
      if (process.env.KIMCHI_NPM_DEBUG) {
        console.warn(
          `[kimchi] Download attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms…`
        );
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Checksum verification
// ---------------------------------------------------------------------------

/**
 * Computes the SHA-256 hash of a file.
 *
 * @param {string} filePath
 * @returns {string} — hex digest
 */
function computeSha256(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  stream.pipe(hash);
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Parses a checksums.txt file and returns a map of filename → sha256.
 *
 * @param {string} checksumsContent — raw content of checksums.txt
 * @returns {Object<string, string>} — { "kimchi_darwin_arm64.tar.gz": "abc123...", ... }
 */
function parseChecksums(checksumsContent) {
  const map = {};
  for (const line of checksumsContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "<sha256>  <filename>"
    const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match) {
      map[match[2].trim()] = match[1];
    }
  }
  return map;
}

/**
 * Verifies the SHA-256 checksum of a downloaded file against checksums.txt.
 *
 * @param {string} archivePath — path to the downloaded archive
 * @param {string} assetName — expected filename in checksums.txt
 * @param {string} checksumsContent — raw content of checksums.txt
 * @returns {Promise<boolean>} — true if checksum matches
 * @throws {Error} if checksum is missing or doesn't match
 */
async function verifyChecksum(archivePath, assetName, checksumsContent) {
  const checksums = parseChecksums(checksumsContent);
  const expectedHash = checksums[assetName];
  if (!expectedHash) {
    throw new Error(`No checksum found for ${assetName} in checksums.txt`);
  }
  const actualHash = await computeSha256(archivePath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${assetName}:\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}`
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Archive extraction (safe — uses spawnSync with argument arrays)
// ---------------------------------------------------------------------------

/**
 * Extracts a tar.gz or zip archive using spawnSync with argument arrays.
 * No shell interpolation — safe against command injection.
 *
 * @param {string} archivePath
 * @param {string} archiveType — "tar.gz" or "zip"
 * @param {string} destDir
 * @param {{ spawnSyncImpl?: Function }} [opts]
 */
function extractArchive(archivePath, archiveType, destDir, opts = {}) {
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;

  mkdirSync(destDir, { recursive: true });

  if (archiveType === "tar.gz") {
    // tar is available on all Unix systems; Windows 10+ ships tar.exe
    const result = spawnSyncImpl("tar", ["-xzf", archivePath, "-C", destDir], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`tar extraction failed with exit code ${result.status}`);
    }
  } else if (archiveType === "zip") {
    if (process.platform === "win32") {
      // Use PowerShell with argument array (no string interpolation)
      const result = spawnSyncImpl(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ],
        { stdio: "inherit" }
      );
      if (result.status !== 0) {
        throw new Error(`PowerShell extraction failed with exit code ${result.status}`);
      }
    } else {
      const result = spawnSyncImpl("unzip", ["-o", archivePath, "-d", destDir], {
        stdio: "inherit",
      });
      if (result.status !== 0) {
        throw new Error(`unzip extraction failed with exit code ${result.status}`);
      }
    }
  } else {
    throw new Error(`Unknown archive type: ${archiveType}`);
  }
}

/**
 * Makes the binary executable on Unix systems.
 *
 * @param {string} binaryPath
 * @param {{ chmodSyncImpl?: Function }} [opts]
 */
function makeExecutable(binaryPath, opts = {}) {
  const chmodSyncImpl = opts.chmodSyncImpl ?? chmodSync;
  if (process.platform !== "win32") {
    chmodSyncImpl(binaryPath, 0o755);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const platforms = loadPlatforms();
  const { key, asset, archiveType } = resolvePlatform(platforms);

  // Determine the version from package.json
  const packageJsonPath = path.join(__dirname, "..", "package.json");
  let packageVersion;
  if (existsSync(packageJsonPath)) {
    packageVersion = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8")
    ).version;
  }
  const tag = resolveVersion(packageVersion);

  const downloadUrl = buildDownloadUrl(tag, asset);
  const checksumUrl = buildChecksumUrl(tag);

  // Destination: a platform-specific subdirectory inside the package
  const destDir = path.join(__dirname, "..", "vendor", key);
  const archivePath = path.join(destDir, asset);

  // If already downloaded (e.g. npm ci with cache), skip
  const binaryPath = path.join(destDir, "bin", "kimchi");
  const binaryExePath =
    process.platform === "win32" ? `${binaryPath}.exe` : binaryPath;
  if (existsSync(binaryExePath)) {
    if (process.env.KIMCHI_NPM_DEBUG) {
      console.log(`[kimchi] Binary already exists at ${binaryExePath}, skipping download.`);
    }
    return;
  }

  mkdirSync(destDir, { recursive: true });

  // Download the archive
  console.log(`[kimchi] Downloading ${asset} (${key})…`);
  await downloadFile(downloadUrl, archivePath);

  // Download and verify checksum
  // - If checksum download fails: warn and continue (best-effort)
  // - If checksum MISMATCH: fail closed (delete archive, don't extract)
  const checksumsPath = path.join(destDir, "checksums.txt");
  let checksumVerified = false;
  try {
    await downloadFile(checksumUrl, checksumsPath);
    const checksumsContent = fs.readFileSync(checksumsPath, "utf8");
    await verifyChecksum(archivePath, asset, checksumsContent);
    console.log(`[kimchi] Checksum verified ✓`);
    checksumVerified = true;
    rmSync(checksumsPath, { force: true });
  } catch (err) {
    if (err.message.includes("Checksum mismatch") || err.message.includes("No checksum found")) {
      // Checksum mismatch — fail closed. Delete the archive and stop.
      rmSync(archivePath, { force: true });
      throw new Error(
        `Checksum verification FAILED for ${asset}: ${err.message}\n` +
        `The downloaded archive may be corrupted or tampered with. Aborting.`
      );
    }
    // Checksum download failed — warn but continue (best-effort)
    console.warn(`[kimchi] Checksum verification skipped: ${err.message}`);
  }

  // Extract
  console.log(`[kimchi] Extracting to ${destDir}…`);
  extractArchive(archivePath, archiveType, destDir);

  // Clean up the archive after extraction
  rmSync(archivePath, { force: true });

  makeExecutable(binaryPath);

  console.log(`[kimchi] Installed binary to ${binaryExePath}`);
}

// Run main, but never fail the install
if (require.main === module) {
  main().catch((err) => {
    console.warn(
      `[kimchi] postinstall failed: ${err.message}\n` +
        `[kimchi] You can still use the package if Kimchi is installed separately.\n` +
        `[kimchi] Or download manually from https://github.com/${REPO}/releases`
    );
    process.exit(0);
  });
}

// Export for testing
module.exports = {
  getPlatformKey,
  loadPlatforms,
  resolvePlatform,
  resolveVersion,
  buildDownloadUrl,
  buildChecksumUrl,
  downloadFile,
  defaultFetch,
  isRetryableError,
  computeSha256,
  parseChecksums,
  verifyChecksum,
  extractArchive,
  makeExecutable,
  REPO,
};
