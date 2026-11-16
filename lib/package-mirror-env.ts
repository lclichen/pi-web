import { getServerSettings } from "./server-settings";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * POSIX `export` prefix for remote shells (SSH / sandbox / Linux relay PTY).
 * Host terminals inherit process.env directly; remote shells do not, so the
 * terminal bridge sends these lines once at startup. Values are validated as
 * credential-free http(s) URLs in server-settings, but quote anyway.
 */
export function packageMirrorExportScript(): string {
  const settings = getServerSettings();
  const lines: string[] = [];
  if (settings.npmRegistry) {
    const value = shellQuote(settings.npmRegistry);
    lines.push(`export NPM_CONFIG_REGISTRY=${value}`);
    lines.push(`export npm_config_registry=${value}`);
  }
  if (settings.pipIndexUrl) {
    lines.push(`export PIP_INDEX_URL=${shellQuote(settings.pipIndexUrl)}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
