import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolvePath } from "../path-security.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-"));
  fs.mkdirSync(path.join(root, "observations"), { recursive: true });
  fs.writeFileSync(path.join(root, "identity.md"), "test");
  fs.writeFileSync(
    path.join(root, "observations", "2026-04.md"),
    "test",
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolvePath", () => {
  it("resolves a simple relative path", async () => {
    const result = await resolvePath(root, "identity.md");
    expect(result).toBe(path.join(root, "identity.md"));
  });

  it("resolves a nested relative path", async () => {
    const result = await resolvePath(root, "observations/2026-04.md");
    expect(result).toBe(path.join(root, "observations", "2026-04.md"));
  });

  it("resolves a path with . segment", async () => {
    const result = await resolvePath(root, "./identity.md");
    expect(result).toBe(path.join(root, "identity.md"));
  });

  it("rejects absolute Unix path", async () => {
    await expect(resolvePath(root, "/etc/passwd")).rejects.toThrow(
      "Absolute paths",
    );
  });

  it("rejects absolute Windows path", async () => {
    await expect(
      resolvePath(root, "C:\\Windows\\system32\\config"),
    ).rejects.toThrow("Absolute paths");
  });

  it("rejects simple .. traversal", async () => {
    await expect(
      resolvePath(root, "../../../etc/passwd"),
    ).rejects.toThrow("Path traversal");
  });

  it("rejects .. hidden in subdirectory", async () => {
    await expect(
      resolvePath(root, "observations/../../etc/passwd"),
    ).rejects.toThrow();
  });

  it("rejects .. surviving normalization", async () => {
    await expect(
      resolvePath(root, "foo/bar/../../../etc/passwd"),
    ).rejects.toThrow();
  });

  it("rejects bare ..", async () => {
    await expect(resolvePath(root, "..")).rejects.toThrow("Path traversal");
  });

  it("rejects symlink escape (CRITICAL/MEDIUM: SYMLINK TOCTOU)", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wb-outside-"));
    const inside = path.join(root, "evil");
    try {
      fs.symlinkSync(outside, inside);
    } catch {
      // Skip on platforms where symlink creation fails (Windows without dev mode).
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }

    try {
      await expect(resolvePath(root, "evil/secret.txt")).rejects.toThrow(
        "ESCAPES_ROOT",
      );
    } finally {
      fs.unlinkSync(inside);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows symlinks that stay inside the vault", async () => {
    const target = path.join(root, "observations");
    const link = path.join(root, "obs-link");
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // Skip if symlinks unsupported.
    }

    try {
      const result = await resolvePath(root, "obs-link/2026-04.md");
      expect(result).toBe(path.join(root, "observations", "2026-04.md"));
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("resolves a new file path through an existing parent", async () => {
    const result = await resolvePath(root, "observations/2099-01.md");
    expect(result).toBe(path.join(root, "observations", "2099-01.md"));
  });

  it("rejects symlink escape in intermediate dir for non-existent file", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wb-outside-"));
    const evilDir = path.join(root, "observations", "evil");
    fs.mkdirSync(path.dirname(evilDir), { recursive: true });
    try {
      fs.symlinkSync(outside, evilDir);
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return; // Skip on platforms without symlink support.
    }

    try {
      await expect(
        resolvePath(root, "observations/evil/2099-01.md"),
      ).rejects.toThrow("ESCAPES_ROOT");
    } finally {
      fs.unlinkSync(evilDir);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
