import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Load local environment files without replacing values explicitly supplied by
 * the process (for example, values injected by Docker or CI).
 *
 * The repository-root `.env` is the recommended location. `shimanto/.env`
 * and a caller-provided `REQMO_ENV_FILE` are also supported for local runs.
 */
export function loadLocalEnvFiles() {
  const cwd = process.cwd();
  const candidates = [
    process.env.REQMO_ENV_FILE,
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "shimanto/.env"),
    path.resolve(cwd, "../.env"),
    path.resolve(cwd, "../shimanto/.env")
  ];

  for (const filePath of [...new Set(candidates)]) {
    if (typeof filePath === "string" && filePath && existsSync(filePath)) {
      process.loadEnvFile(filePath);
    }
  }
}
