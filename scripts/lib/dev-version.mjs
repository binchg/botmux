const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseDevVersion(value) {
  if (typeof value !== 'string') throw new Error('dev version 必须是字符串');
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) throw new Error(`无效 dev version: ${value}`);
  return match.slice(1).map(Number);
}

export function bumpPatchVersion(value) {
  const [major, minor, patch] = parseDevVersion(value);
  if (patch >= Number.MAX_SAFE_INTEGER) throw new Error('dev version patch 已超出安全整数范围');
  return `${major}.${minor}.${patch + 1}`;
}

export function readVersionPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`dev-version.json 不是有效 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { version: parseDevVersion(payload?.version).join('.') };
}
