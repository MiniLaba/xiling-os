import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/**
 * Removes containers left behind by a crashed previous session (they carry the
 * org.xiling.sandbox label). Runs once at server startup, when no legitimate
 * sandbox of this instance can be alive yet; failures are reported, not fatal.
 */
export async function reapOrphanSandboxes(): Promise<number> {
  const listed = await executeFile("docker", ["ps", "-aq", "--filter", "label=org.xiling.sandbox=true"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const ids = listed.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) return 0;
  await executeFile("docker", ["rm", "--force", ...ids], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  return ids.length;
}
