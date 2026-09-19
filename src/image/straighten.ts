/**
 * Straighten-by-line: turns a reference line the user drew into a rotation.
 *
 * Two things this has to get right, both of which a plain `atan2` got wrong:
 *
 * 1. The deltas must be **pixels**, not fractions of the container. Normalizing
 *    x by the container width and y by its height stretches the angle by the
 *    container's aspect ratio — a 3 degree horizon came out as 5 on a wide canvas.
 *
 * 2. The line may reference either axis. Drawing along a church tower means
 *    "make this vertical", not "rotate this edge onto the horizontal" — which is
 *    what atan2 alone asks for, and why such a line used to spin the photo by
 *    almost 90 degrees.
 */

/** Below this the drag is a stray click, not a reference line. */
export const MIN_STRAIGHTEN_LENGTH_PX = 20;

/** Matches the rotation slider; a straighten result never exceeds it. */
export const MAX_STRAIGHTEN_DEGREES = 45;

/**
 * The *correction* in degrees that puts the drawn line on its nearest axis.
 *
 * This is a delta, not an absolute rotation: the line is drawn on the photo as
 * it is currently displayed, so whatever rotation is already applied stays and
 * this rides on top of it. Treating it as absolute made a level line on an
 * upside-down photo (rotation 180) snap back to 0 - a 180 degree jump.
 *
 * Null when the drag was too short to carry a direction.
 */
export function straightenRotation(dxPx: number, dyPx: number): number | null {
  if (Math.hypot(dxPx, dyPx) < MIN_STRAIGHTEN_LENGTH_PX) return null;

  // Direction, not orientation: a line and its reverse mean the same thing.
  let angle = Math.atan2(dyPx, dxPx) * (180 / Math.PI);
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;

  // Past 45 degrees the line is closer to vertical, so correct against that axis.
  const offAxis = Math.abs(angle) > 45 ? angle - Math.sign(angle) * 90 : angle;

  const correction = -Math.round(offAxis * 10) / 10;
  // `-0` would travel into the adjustment stack and print as "-0.0 degrees".
  if (correction === 0) return 0;
  return Math.max(-MAX_STRAIGHTEN_DEGREES, Math.min(MAX_STRAIGHTEN_DEGREES, correction));
}

/** Folds a rotation into (-180, 180] so repeated corrections cannot drift. */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  let value = degrees % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value === 0 ? 0 : Math.round(value * 10) / 10;
}
