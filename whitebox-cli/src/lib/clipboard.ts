import { spawn } from "node:child_process";
import os from "node:os";

/**
 * Platform-native clipboard write. No npm dependency; uses the built-in
 * OS utilities (clip.exe on Windows, pbcopy on macOS, xclip/xsel/wl-copy
 * on Linux). Returns the utility that was used, or throws if none works.
 */
export async function writeClipboard(text: string): Promise<string> {
  const platform = os.platform();
  const candidates = getCandidates(platform);

  for (const candidate of candidates) {
    try {
      await pipeText(candidate.cmd, candidate.args, text);
      return candidate.name;
    } catch {
      continue;
    }
  }

  throw new Error(
    `No clipboard utility available on ${platform}. ` +
      (platform === "linux"
        ? "Install xclip, xsel, or wl-clipboard."
        : "This is unexpected; please file an issue."),
  );
}

interface Candidate {
  name: string;
  cmd: string;
  args: string[];
}

function getCandidates(platform: NodeJS.Platform): Candidate[] {
  switch (platform) {
    case "darwin":
      return [{ name: "pbcopy", cmd: "pbcopy", args: [] }];
    case "win32":
      return [
        { name: "clip.exe", cmd: "clip", args: [] },
        { name: "clip.exe (explicit)", cmd: "clip.exe", args: [] },
      ];
    case "linux":
      return [
        { name: "wl-copy", cmd: "wl-copy", args: [] },
        { name: "xclip", cmd: "xclip", args: ["-selection", "clipboard"] },
        { name: "xsel", cmd: "xsel", args: ["--clipboard", "--input"] },
      ];
    default:
      return [];
  }
}

function pipeText(cmd: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
    });
    child.stdin?.write(text);
    child.stdin?.end();
  });
}
