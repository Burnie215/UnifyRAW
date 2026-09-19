export function formatShutterSpeed(value: string | undefined): string | null {
  if (!value) return null;
  return /(?:s|sec|″)$/i.test(value.trim()) ? value : `${value}s`;
}
