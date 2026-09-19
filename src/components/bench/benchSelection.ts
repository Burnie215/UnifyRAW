import type { PhotoView } from '../../storage/repos';
import { normaliseCameraKey } from '../../engine/developProfile';
import { normaliseLensKey } from '../../engine/lensProfile';
import { RawDecoder } from '../../engine/RawDecoder';

/** A camera or lens the whole selection agrees on. */
export interface BenchSubject {
  key: string;
  label: string;
}

export interface BenchSelection {
  photos: PhotoView[];
  /** Set when every photo names the same camera. */
  camera: BenchSubject | null;
  /** Set when every photo names the same lens. */
  lens: BenchSubject | null;
  /** How many distinct cameras and lenses the selection covers. */
  cameraCount: number;
  lensCount: number;
  /** True when at least one photo names no camera / no lens at all. */
  cameraMissing: boolean;
  lensMissing: boolean;
  /** How many of the photos are RAW - the only ones a profile can reach. */
  rawCount: number;
  /**
   * The photos that break the agreement, and what they break.
   *
   * Naming them is the difference between a hint and a dead end: "one of your
   * photos records no lens" leaves the user to find it among nine, while a
   * frame around that one tile is the answer itself.
   */
  odd: Map<number, 'camera' | 'lens' | 'both'>;
}

function agreedOn(
  photos: PhotoView[],
  read: (p: PhotoView) => string | null | undefined,
  normalise: (v: string | null | undefined) => string,
  accepted: ReadonlySet<number>,
): {
  subject: BenchSubject | null; count: number; missing: boolean; oddIds: number[];
} {
  const seen = new Map<string, { label: string; ids: number[] }>();
  const blank: number[] = [];
  for (const photo of photos) {
    // A photo the user has vouched for counts as belonging, whatever its EXIF
    // says or fails to say. They know what they shot it with; the file may
    // simply not record it.
    if (accepted.has(photo.id)) continue;
    const raw = read(photo);
    const key = normalise(raw);
    // A photo with no name at all cannot agree with anything: counting it as
    // a match would let one unlabelled frame make any selection look uniform.
    // It is reported separately from a genuine disagreement, because "one of
    // your photos has no lens recorded" and "you picked two lenses" are
    // different problems with different fixes.
    if (!key) { blank.push(photo.id); continue; }
    if (!seen.has(key)) seen.set(key, { label: (raw ?? '').trim(), ids: [] });
    seen.get(key)!.ids.push(photo.id);
  }

  const missing = blank.length > 0;
  if (!missing && seen.size === 1) {
    const [[key, entry]] = [...seen];
    return { subject: { key, label: entry.label }, count: 1, missing: false, oddIds: [] };
  }

  // The odd ones out are the blanks plus everything outside the largest
  // group - the reading that leaves the user with the fewest tiles to judge.
  const groups = [...seen.values()].sort((a, b) => b.ids.length - a.ids.length);
  const majority = groups[0];
  const oddIds = [...blank, ...groups.slice(1).flatMap((g) => g.ids)];
  const subject = null;
  void majority;
  return { subject, count: seen.size, missing, oddIds };
}

/**
 * What the selected photos have in common, and therefore what can be measured
 * from them.
 *
 * A camera profile describes a sensor and a lens profile a piece of glass, so
 * each may only be saved when every photo on the bench came through that one
 * thing. Mixing two bodies into one camera profile would average two sensors
 * into a rendering that matches neither.
 */
export function analyseBenchSelection(
  photos: PhotoView[],
  /** Photos the user has vouched for despite what their EXIF says. */
  accepted: ReadonlySet<number> = new Set(),
): BenchSelection {
  const camera = agreedOn(photos, (p) => p.camera, normaliseCameraKey, accepted);
  const lens = agreedOn(photos, (p) => p.lens, normaliseLensKey, accepted);
  const odd = new Map<number, 'camera' | 'lens' | 'both'>();
  for (const id of camera.oddIds) odd.set(id, 'camera');
  for (const id of lens.oddIds) odd.set(id, odd.has(id) ? 'both' : 'lens');
  return {
    odd,
    photos,
    camera: photos.length > 0 ? camera.subject : null,
    lens: photos.length > 0 ? lens.subject : null,
    cameraCount: camera.count,
    lensCount: lens.count,
    cameraMissing: camera.missing,
    lensMissing: lens.missing,
    rawCount: photos.filter((p) => RawDecoder.isRawFile(p.name)).length,
  };
}

/** Why nothing can be saved from this selection, or null when something can. */
export function benchSelectionHint(selection: BenchSelection, minPhotos = 2): string | null {
  if (selection.photos.length < minPhotos) {
    return `Wähle in der Galerie mindestens ${minPhotos} Bilder aus — an einem einzelnen Bild lässt sich eine Grundeinstellung nicht beurteilen.`;
  }
  if (!selection.camera && !selection.lens) {
    // `odd` is never empty here: with neither subject agreed there is always
    // at least one photo outside the largest group or naming nothing at all.
    // So the hint always has tiles to point at, and there is no case left
    // that would have to be described by counting cameras instead.
    const n = selection.odd.size;
    return `${n === 1 ? 'Ein Bild passt' : `${n} Bilder passen`} nicht zu den übrigen — ${n === 1 ? 'es ist' : 'sie sind'} umrahmt. Entweder aus der Auswahl nehmen (×) oder bestätigen, dass ${n === 1 ? 'es' : 'sie'} mit derselben Kamera und demselben Objektiv entstanden ${n === 1 ? 'ist' : 'sind'} (✓).`;
  }
  if (selection.rawCount === 0) {
    return 'Kein RAW in der Auswahl. Grundverarbeitung und Objektivkorrektur greifen nur auf RAW-Dateien.';
  }
  return null;
}
