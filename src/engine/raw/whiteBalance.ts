/** Clamp editor-native white-balance sliders to their supported range. */
function sliderUnit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, (value ?? 0) / 100));
}

/**
 * Convert the editor's relative temperature/tint controls into multiplicative
 * gains for linear RGB samples.
 *
 * The gains use a logarithmic (stop-based) scale and keep their geometric
 * mean at one, so moving white balance does not behave like an additive color
 * overlay and does not introduce a broad exposure jump.
 */
export function relativeRawWhiteBalanceGains(
  temperature: number | undefined,
  tint: number | undefined,
): [number, number, number] {
  const temperatureStops = sliderUnit(temperature) * 0.75;
  const tintSpread = sliderUnit(tint) * 0.6;

  return [
    2 ** (temperatureStops + tintSpread * 0.25),
    2 ** (-tintSpread * 0.5),
    2 ** (-temperatureStops + tintSpread * 0.25),
  ];
}

function validBaseGain(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : 1;
}

/** Combine camera/as-shot gains with the user's relative WB correction. */
export function rawWhiteBalanceGains(
  base: readonly number[] | null | undefined,
  temperature: number | undefined,
  tint: number | undefined,
): [number, number, number] {
  const relative = relativeRawWhiteBalanceGains(temperature, tint);
  return [
    validBaseGain(base?.[0]) * relative[0],
    validBaseGain(base?.[1]) * relative[1],
    validBaseGain(base?.[2]) * relative[2],
  ];
}
