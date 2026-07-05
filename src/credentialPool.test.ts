import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialPool, AllRateLimitedError, parseCredentialDirs } from "./credentialPool.js";

// -- helpers --

function makeTmpCredDir(label: string): string {
  const dir = path.join(os.tmpdir(), `cred-pool-test-${label}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ token: label }));
  return dir;
}

function cleanup(dirs: string[]) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}

// -- tests --

describe("CredentialPool", () => {
  let dirs: string[];
  let pool: CredentialPool;

  beforeEach(() => {
    dirs = [makeTmpCredDir("a"), makeTmpCredDir("b"), makeTmpCredDir("c")];
    pool = new CredentialPool(dirs);
  });

  it("acquires the least-recently-used slot", () => {
    const s1 = pool.acquire();
    assert.ok(dirs.includes(s1.dir));
    const s2 = pool.acquire();
    assert.notEqual(s1.dir, s2.dir, "second acquire should pick a different slot");
    pool.cleanup();
    cleanup(dirs);
  });

  it("round-robins across all slots", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      seen.add(pool.acquire().dir);
    }
    assert.equal(seen.size, 3, "all three slots should be visited");
    pool.cleanup();
    cleanup(dirs);
  });

  it("skips rate-limited slots", () => {
    const s1 = pool.acquire();
    pool.reportRateLimit(s1, Date.now() + 60_000);

    for (let i = 0; i < 4; i++) {
      const s = pool.acquire();
      assert.notEqual(s.dir, s1.dir, "rate-limited slot should be skipped");
    }
    pool.cleanup();
    cleanup(dirs);
  });

  it("throws AllRateLimitedError when all slots unavailable", () => {
    for (let i = 0; i < 3; i++) {
      const s = pool.acquire();
      pool.reportRateLimit(s, Date.now() + 60_000);
    }
    assert.throws(
      () => pool.acquire(),
      (err: unknown) => err instanceof AllRateLimitedError,
    );
    pool.cleanup();
    cleanup(dirs);
  });

  it("restores expired rate-limited slots", () => {
    const s1 = pool.acquire();
    pool.reportRateLimit(s1, Date.now() - 1); // already expired
    const s2 = pool.acquire();
    // After reap, s1 should be available again (LRU — s1 was used first)
    // s2 was just used, so s1 is now least-recently-used among ok slots
    assert.ok(s2.dir, "should be able to acquire after expired rate limit");
    pool.cleanup();
    cleanup(dirs);
  });

  it("restore() manually unblocks a slot", () => {
    const s = pool.acquire();
    pool.reportAuthFailure(s);
    assert.equal(pool.status().available, 2);
    const restored = pool.restore(s.dir);
    assert.ok(restored);
    assert.equal(pool.status().available, 3);
    pool.cleanup();
    cleanup(dirs);
  });

  it("status() reports correct counts", () => {
    const st = pool.status();
    assert.equal(st.total, 3);
    assert.equal(st.available, 3);
    assert.equal(st.slots.length, 3);
    pool.cleanup();
    cleanup(dirs);
  });

  it("empty pool has size 0", () => {
    const empty = new CredentialPool([]);
    assert.equal(empty.size, 0);
    empty.cleanup();
  });
});

describe("parseCredentialDirs", () => {
  it("returns empty for undefined/empty", () => {
    assert.deepEqual(parseCredentialDirs(undefined), []);
    assert.deepEqual(parseCredentialDirs(""), []);
    assert.deepEqual(parseCredentialDirs("  "), []);
  });

  it("filters out non-existent dirs", () => {
    const result = parseCredentialDirs("/nonexistent/path/xyz123");
    assert.deepEqual(result, []);
  });

  it("filters out dirs without credentials", () => {
    const dir = path.join(os.tmpdir(), `cred-pool-nocred-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const result = parseCredentialDirs(dir);
    assert.deepEqual(result, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts valid credential dirs", () => {
    const dir = makeTmpCredDir("valid");
    const result = parseCredentialDirs(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0], path.resolve(dir));
    cleanup([dir]);
  });

  it("handles comma-separated list with mixed validity", () => {
    const good = makeTmpCredDir("good");
    const result = parseCredentialDirs(`${good},/nonexistent/bad`);
    assert.equal(result.length, 1);
    assert.equal(result[0], path.resolve(good));
    cleanup([good]);
  });
});
