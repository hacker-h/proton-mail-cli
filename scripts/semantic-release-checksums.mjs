import { writeSha256Sums } from "./release-checksums.mjs";

export async function prepare(pluginConfig = {}, context = {}) {
  const directory = pluginConfig.directory || "release";
  const checksumPath = writeSha256Sums(directory);
  context.logger?.log?.(`Wrote release checksums to ${checksumPath}`);
}
