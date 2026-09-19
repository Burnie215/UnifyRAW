const SENSITIVE_CONFIG_KEY = /(?:password|passphrase|secret|token|api[_-]?key|authorization|credential|private[_-]?key|otp)/i;

/** Remove source credentials before a configuration leaves its device. */
export function redactSourceConfigForSync(value: unknown): Record<string, unknown> {
  return redactObject(parseConfig(value));
}

/** Apply a remote config without erasing secrets entered on this device. */
export function mergeSourceConfigFromSync(
  remoteValue: unknown,
  localValue: unknown,
): Record<string, unknown> {
  const remote = redactSourceConfigForSync(remoteValue);
  const local = parseConfig(localValue);
  return mergeObject(remote, local);
}

export function isSensitiveSourceConfigKey(key: string): boolean {
  return SENSITIVE_CONFIG_KEY.test(key);
}

function parseConfig(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; }
    catch { return {}; }
  }
  return isPlainObject(parsed) ? parsed : {};
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isSensitiveSourceConfigKey(key)) continue;
    if (isPlainObject(value)) result[key] = redactObject(value);
    else if (Array.isArray(value)) result[key] = value.map(redactArrayValue);
    else result[key] = value;
  }
  return result;
}

function mergeObject(
  remote: Record<string, unknown>,
  local: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...remote };
  for (const [key, localValue] of Object.entries(local)) {
    if (isSensitiveSourceConfigKey(key)) {
      result[key] = localValue;
      continue;
    }
    if (isPlainObject(localValue) && isPlainObject(remote[key])) {
      result[key] = mergeObject(remote[key], localValue);
    }
  }
  return result;
}

function redactArrayValue(value: unknown): unknown {
  if (isPlainObject(value)) return redactObject(value);
  if (Array.isArray(value)) return value.map(redactArrayValue);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
