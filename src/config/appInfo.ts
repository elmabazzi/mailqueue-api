import { readFileSync } from 'node:fs';

/** Reads name and version from package.json (works from both src/ with tsx and dist/ with node). */
export function readPackageInfo(): { name: string; version: string } {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    return { name: pkg.name ?? 'mailqueue-api', version: pkg.version ?? 'unknown' };
  } catch {
    return { name: 'mailqueue-api', version: 'unknown' };
  }
}
