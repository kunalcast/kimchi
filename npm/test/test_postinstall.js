/**
 * Unit tests for postinstall.js — binary download and extraction logic.
 * Run with: node --test test/test_postinstall.js
 */

"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
  getPlatformKey,
  loadPlatforms,
  resolvePlatform,
  resolveVersion,
  buildDownloadUrl,
  buildChecksumUrl,
  downloadFile,
  isRetryableError,
  computeSha256,
  parseChecksums,
  verifyChecksum,
  extractArchive,
  makeExecutable,
  REPO,
} = require("../bin/postinstall");

const platforms = loadPlatforms();

// ---------------------------------------------------------------------------
// resolvePlatform
// ---------------------------------------------------------------------------

describe("resolvePlatform", () => {
  test("resolves darwin-arm64", () => {
    const result = resolvePlatform(platforms, "darwin", "arm64");
    assert.strictEqual(result.key, "darwin-arm64");
    assert.strictEqual(result.asset, "kimchi_darwin_arm64.tar.gz");
    assert.strictEqual(result.archiveType, "tar.gz");
  });

  test("resolves linux-x64 (maps to amd64 asset)", () => {
    const result = resolvePlatform(platforms, "linux", "x64");
    assert.strictEqual(result.key, "linux-x64");
    assert.strictEqual(result.asset, "kimchi_linux_amd64.tar.gz");
  });

  test("resolves win32-x64", () => {
    const result = resolvePlatform(platforms, "win32", "x64");
    assert.strictEqual(result.key, "win32-x64");
    assert.strictEqual(result.asset, "kimchi_windows_amd64.zip");
    assert.strictEqual(result.archiveType, "zip");
  });

  test("throws on unsupported platform", () => {
    assert.throws(
      () => resolvePlatform(platforms, "freebsd", "x64"),
      /does not ship a pre-built binary/
    );
  });

  test("throws on unsupported arch (arm64 Windows)", () => {
    assert.throws(
      () => resolvePlatform(platforms, "win32", "arm64"),
      /does not ship a pre-built binary/
    );
  });

  test("error message includes supported platforms list", () => {
    try {
      resolvePlatform(platforms, "aix", "ppc64");
    } catch (err) {
      assert.ok(err.message.includes("darwin-arm64"));
      assert.ok(err.message.includes("win32-x64"));
    }
  });
});

// ---------------------------------------------------------------------------
// resolveVersion
// ---------------------------------------------------------------------------

describe("resolveVersion", () => {
  const origEnv = process.env.KIMCHI_VERSION;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.KIMCHI_VERSION;
    else process.env.KIMCHI_VERSION = origEnv;
  });

  test("uses KIMCHI_VERSION env var when set", () => {
    process.env.KIMCHI_VERSION = "v0.1.80";
    assert.strictEqual(resolveVersion("0.1.84"), "v0.1.80");
  });

  test("prepends 'v' to KIMCHI_VERSION if missing", () => {
    process.env.KIMCHI_VERSION = "0.1.80";
    assert.strictEqual(resolveVersion("0.1.84"), "v0.1.80");
  });

  test("uses package version when it's a real release", () => {
    delete process.env.KIMCHI_VERSION;
    assert.strictEqual(resolveVersion("0.1.84"), "v0.1.84");
  });

  test("falls back to 'latest' when version is 0.0.0 (dev placeholder)", () => {
    delete process.env.KIMCHI_VERSION;
    assert.strictEqual(resolveVersion("0.0.0"), "latest");
  });

  test("falls back to 'latest' when no version available", () => {
    delete process.env.KIMCHI_VERSION;
    assert.strictEqual(resolveVersion(undefined), "latest");
  });
});

// ---------------------------------------------------------------------------
// buildDownloadUrl & buildChecksumUrl
// ---------------------------------------------------------------------------

describe("buildDownloadUrl", () => {
  test("builds correct URL for tagged version", () => {
    const url = buildDownloadUrl("v0.1.84", "kimchi_darwin_arm64.tar.gz");
    assert.strictEqual(
      url,
      "https://github.com/getkimchi/kimchi/releases/download/v0.1.84/kimchi_darwin_arm64.tar.gz"
    );
  });

  test("builds correct URL for 'latest'", () => {
    const url = buildDownloadUrl("latest", "kimchi_linux_amd64.tar.gz");
    assert.strictEqual(
      url,
      "https://github.com/getkimchi/kimchi/releases/latest/download/kimchi_linux_amd64.tar.gz"
    );
  });

  test("builds correct URL for Windows zip", () => {
    const url = buildDownloadUrl("v0.1.84", "kimchi_windows_amd64.zip");
    assert.ok(url.endsWith("kimchi_windows_amd64.zip"));
  });
});

describe("buildChecksumUrl", () => {
  test("builds checksum URL for tagged version", () => {
    const url = buildChecksumUrl("v0.1.84");
    assert.strictEqual(
      url,
      "https://github.com/getkimchi/kimchi/releases/download/v0.1.84/checksums.txt"
    );
  });

  test("builds checksum URL for 'latest'", () => {
    const url = buildChecksumUrl("latest");
    assert.strictEqual(
      url,
      "https://github.com/getkimchi/kimchi/releases/latest/download/checksums.txt"
    );
  });
});

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe("isRetryableError", () => {
  test("retries on network errors (no statusCode)", () => {
    const err = new Error("ECONNRESET");
    assert.strictEqual(isRetryableError(err), true);
  });

  test("retries on 500 server errors", () => {
    const err = new Error("HTTP 500");
    err.statusCode = 500;
    assert.strictEqual(isRetryableError(err), true);
  });

  test("retries on 503 service unavailable", () => {
    const err = new Error("HTTP 503");
    err.statusCode = 503;
    assert.strictEqual(isRetryableError(err), true);
  });

  test("does NOT retry on 404", () => {
    const err = new Error("HTTP 404");
    err.statusCode = 404;
    assert.strictEqual(isRetryableError(err), false);
  });

  test("does NOT retry on 403", () => {
    const err = new Error("HTTP 403");
    err.statusCode = 403;
    assert.strictEqual(isRetryableError(err), false);
  });

  test("does NOT retry on 401", () => {
    const err = new Error("HTTP 401");
    err.statusCode = 401;
    assert.strictEqual(isRetryableError(err), false);
  });
});

// ---------------------------------------------------------------------------
// downloadFile (mocked fetch)
// ---------------------------------------------------------------------------

describe("downloadFile", () => {
  test("calls fetchImpl with correct URL and dest path", async () => {
    let calledUrl, calledDest;
    const mockFetch = async (url, dest) => {
      calledUrl = url;
      calledDest = dest;
    };

    await downloadFile("https://example.com/test.tar.gz", "/tmp/test.tar.gz", {
      fetchImpl: mockFetch,
    });

    assert.strictEqual(calledUrl, "https://example.com/test.tar.gz");
    assert.strictEqual(calledDest, "/tmp/test.tar.gz");
  });

  test("retries on transient errors but not on 404", async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      if (attempts < 2) {
        const err = new Error("ECONNRESET");
        throw err;
      }
      // succeeds on 2nd attempt
    };

    await downloadFile("https://example.com/test", "/tmp/test", {
      fetchImpl: mockFetch,
      maxRetries: 5,
      baseDelay: 1,
    });
    assert.strictEqual(attempts, 2);
  });

  test("does NOT retry on 404 (fails immediately)", async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      const err = new Error("HTTP 404");
      err.statusCode = 404;
      throw err;
    };

    await assert.rejects(
      downloadFile("https://example.com/test", "/tmp/test", {
        fetchImpl: mockFetch,
        maxRetries: 5,
        baseDelay: 1,
      }),
      /HTTP 404/
    );
    assert.strictEqual(attempts, 1); // no retries
  });

  test("throws after maxRetries exhausted", async () => {
    const mockFetch = async () => {
      const err = new Error("ECONNRESET");
      throw err;
    };

    await assert.rejects(
      downloadFile("https://example.com/test", "/tmp/test", {
        fetchImpl: mockFetch,
        maxRetries: 2,
        baseDelay: 1,
      }),
      /ECONNRESET/
    );
  });

  test("does not retry on first success", async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
    };

    await downloadFile("https://example.com/test", "/tmp/test", {
      fetchImpl: mockFetch,
      maxRetries: 5,
    });
    assert.strictEqual(attempts, 1);
  });
});

// ---------------------------------------------------------------------------
// Checksum verification
// ---------------------------------------------------------------------------

describe("parseChecksums", () => {
  test("parses checksums.txt format", () => {
    const content = `aabbccdd11223344556677889900112233445566778899001122334455667788  kimchi_darwin_arm64.tar.gz\nffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100  kimchi_linux_amd64.tar.gz\n`;
    const result = parseChecksums(content);
    assert.strictEqual(result["kimchi_darwin_arm64.tar.gz"], "aabbccdd11223344556677889900112233445566778899001122334455667788");
    assert.strictEqual(result["kimchi_linux_amd64.tar.gz"], "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100");
  });

  test("ignores empty lines", () => {
    const content = `\naabbccdd11223344556677889900112233445566778899001122334455667788  file.tar.gz\n\n`;
    const result = parseChecksums(content);
    assert.strictEqual(Object.keys(result).length, 1);
  });

  test("returns empty map for empty content", () => {
    const result = parseChecksums("");
    assert.strictEqual(Object.keys(result).length, 0);
  });
});

describe("verifyChecksum", () => {
  test("returns true when checksum matches", async () => {
    // Create a temp file with known content
    const tmpFile = path.join(os.tmpdir(), "kimchi-test-checksum.txt");
    fs.writeFileSync(tmpFile, "test content");

    const hash = await computeSha256(tmpFile);
    const checksumsContent = `${hash}  kimchi-test-checksum.txt\n`;

    const result = await verifyChecksum(tmpFile, "kimchi-test-checksum.txt", checksumsContent);
    assert.strictEqual(result, true);

    fs.unlinkSync(tmpFile);
  });

  test("throws when checksum doesn't match", async () => {
    const tmpFile = path.join(os.tmpdir(), "kimchi-test-checksum-bad.txt");
    fs.writeFileSync(tmpFile, "different content");

    const checksumsContent = `0000000000000000000000000000000000000000000000000000000000000000  kimchi-test-checksum-bad.txt\n`;

    await assert.rejects(
      async () => verifyChecksum(tmpFile, "kimchi-test-checksum-bad.txt", checksumsContent),
      /Checksum mismatch/
    );

    fs.unlinkSync(tmpFile);
  });

  test("throws when asset not in checksums", async () => {
    const tmpFile = path.join(os.tmpdir(), "kimchi-test-checksum-missing.txt");
    fs.writeFileSync(tmpFile, "content");

    await assert.rejects(
      async () => verifyChecksum(tmpFile, "nonexistent-asset.tar.gz", "otherhash  other.tar.gz\n"),
      /No checksum found/
    );

    fs.unlinkSync(tmpFile);
  });
});

describe("computeSha256", () => {
  test("computes consistent hash", async () => {
    const tmpFile = path.join(os.tmpdir(), "kimchi-test-hash.txt");
    fs.writeFileSync(tmpFile, "hello world");

    const hash1 = await computeSha256(tmpFile);
    const hash2 = await computeSha256(tmpFile);

    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64); // SHA-256 hex

    fs.unlinkSync(tmpFile);
  });
});

// ---------------------------------------------------------------------------
// extractArchive (uses spawnSync with argument arrays — no shell injection)
// ---------------------------------------------------------------------------

describe("extractArchive", () => {
  test("calls tar with argument array for tar.gz", () => {
    let calledBin, calledArgs;
    const mockSpawn = (bin, args) => {
      calledBin = bin;
      calledArgs = args;
      return { status: 0 };
    };

    extractArchive("/tmp/test.tar.gz", "tar.gz", "/tmp/dest", {
      spawnSyncImpl: mockSpawn,
    });

    assert.strictEqual(calledBin, "tar");
    assert.deepStrictEqual(calledArgs, ["-xzf", "/tmp/test.tar.gz", "-C", "/tmp/dest"]);
  });

  test("calls unzip with argument array on non-Windows", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    let calledBin, calledArgs;
    const mockSpawn = (bin, args) => {
      calledBin = bin;
      calledArgs = args;
      return { status: 0 };
    };

    extractArchive("/tmp/test.zip", "zip", "/tmp/dest", {
      spawnSyncImpl: mockSpawn,
    });

    assert.strictEqual(calledBin, "unzip");
    assert.deepStrictEqual(calledArgs, ["-o", "/tmp/test.zip", "-d", "/tmp/dest"]);

    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  test("calls powershell.exe with argument array on Windows", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    let calledBin, calledArgs;
    const mockSpawn = (bin, args) => {
      calledBin = bin;
      calledArgs = args;
      return { status: 0 };
    };

    extractArchive("C:\\tmp\\test.zip", "zip", "C:\\tmp\\dest", {
      spawnSyncImpl: mockSpawn,
    });

    assert.strictEqual(calledBin, "powershell.exe");
    assert.ok(Array.isArray(calledArgs));
    assert.ok(calledArgs.includes("-NoProfile"));

    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  test("throws on unknown archive type", () => {
    assert.throws(
      () => extractArchive("/tmp/test.rar", "rar", "/tmp/dest"),
      /Unknown archive type/
    );
  });

  test("throws when tar exits non-zero", () => {
    const mockSpawn = () => ({ status: 2 });
    assert.throws(
      () => extractArchive("/tmp/test.tar.gz", "tar.gz", "/tmp/dest", {
        spawnSyncImpl: mockSpawn,
      }),
      /tar extraction failed/
    );
  });
});

// ---------------------------------------------------------------------------
// makeExecutable
// ---------------------------------------------------------------------------

describe("makeExecutable", () => {
  const origPlatform = process.platform;
  let savedPlatform;

  beforeEach(() => {
    savedPlatform = process.platform;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
  });

  test("calls chmodSync on non-Windows", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    let chmodCalled = false;
    let chmodPath, chmodMode;
    const mockChmod = (p, mode) => {
      chmodCalled = true;
      chmodPath = p;
      chmodMode = mode;
    };

    makeExecutable("/path/to/kimchi", { chmodSyncImpl: mockChmod });

    assert.ok(chmodCalled);
    assert.strictEqual(chmodPath, "/path/to/kimchi");
    assert.strictEqual(chmodMode, 0o755);
  });

  test("does not call chmod on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    let chmodCalled = false;
    const mockChmod = () => {
      chmodCalled = true;
    };

    makeExecutable("C:\\path\\to\\kimchi.exe", { chmodSyncImpl: mockChmod });

    assert.ok(!chmodCalled);
  });
});

// ---------------------------------------------------------------------------
// getPlatformKey
// ---------------------------------------------------------------------------

describe("getPlatformKey", () => {
  test("formats platform-arch correctly", () => {
    assert.strictEqual(getPlatformKey("darwin", "arm64"), "darwin-arm64");
    assert.strictEqual(getPlatformKey("linux", "x64"), "linux-x64");
    assert.strictEqual(getPlatformKey("win32", "x64"), "win32-x64");
  });

  test("uses process defaults when no args given", () => {
    const key = getPlatformKey();
    assert.strictEqual(key, `${process.platform}-${process.arch}`);
  });
});
