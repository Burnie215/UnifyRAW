/**
 * Tracks overlapping runs of one kind of work (scans of several sources) and
 * reports only the edges: busy when the first starts, idle when the last ends.
 */
export function activityCounter(onChange: (active: boolean) => void) {
  let running = 0;
  return {
    begin(): void {
      running++;
      if (running === 1) onChange(true);
    },
    end(): void {
      if (running === 0) return;
      running--;
      if (running === 0) onChange(false);
    },
  };
}
