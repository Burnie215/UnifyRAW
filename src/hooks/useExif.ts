import { useState, useEffect } from 'react';
import type { PhotoView } from '../storage/repos';
import { readImageDimensions } from '../image/imageDimensions';
import { RawDecoder, rawDecoder } from '../engine/RawDecoder';

interface ExifTags extends Record<string, unknown> {
  ImageWidth?: number;
  ExifImageWidth?: number;
  ImageHeight?: number;
  ExifImageHeight?: number;
  Make?: string;
  Model?: string;
  LensModel?: string;
  Lens?: string;
  ExposureTime?: number;
  ShutterSpeedValue?: number;
  FNumber?: number;
  ApertureValue?: number;
  ISO?: number;
  ISOSpeed?: number;
  StandardOutputSensitivity?: number;
  RecommendedExposureIndex?: number;
  FocalLength?: number;
  FocalLengthIn35mmFormat?: number;
  DateTimeOriginal?: Date;
  CreateDate?: Date;
  latitude?: number;
  longitude?: number;
  GPSAltitude?: number;
  Keywords?: string[];
  subject?: string[];
  Copyright?: string;
  ImageDescription?: string;
  Description?: string;
}

function hasCaptureMetadata(tags: ExifTags | null): boolean {
  return Boolean(
    tags?.ExposureTime || tags?.ShutterSpeedValue
    || tags?.FNumber || tags?.ApertureValue
    || tags?.ISO || tags?.ISOSpeed || tags?.StandardOutputSensitivity
    || tags?.RecommendedExposureIndex
    || tags?.FocalLength || tags?.FocalLengthIn35mmFormat,
  );
}

function mergeDefined(primary: ExifTags | null, fallback: ExifTags | null): ExifTags | null {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const merged = { ...fallback };
  for (const [key, value] of Object.entries(primary)) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  return merged;
}

function finiteNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

/** Cameras do not all write the same EXIF tags. Normalize APEX and modern
 * sensitivity variants to the fields consumed by PhotoLib's UI. */
export function normalizeExifTags(input: Record<string, unknown> | null): ExifTags | null {
  if (!input) return null;
  const tags = { ...input } as ExifTags;
  const shutterApex = finiteNumber(tags.ShutterSpeedValue);
  const apertureApex = finiteNumber(tags.ApertureValue);
  tags.ExposureTime = finiteNumber(tags.ExposureTime)
    ?? (shutterApex !== undefined ? 2 ** -shutterApex : undefined);
  tags.FNumber = finiteNumber(tags.FNumber)
    ?? (apertureApex !== undefined ? 2 ** (apertureApex / 2) : undefined);
  tags.ISO = finiteNumber(tags.ISO)
    ?? finiteNumber(tags.ISOSpeed)
    ?? finiteNumber(tags.StandardOutputSensitivity)
    ?? finiteNumber(tags.RecommendedExposureIndex);
  tags.FocalLength = finiteNumber(tags.FocalLength)
    ?? finiteNumber(tags.FocalLengthIn35mmFormat);
  return tags;
}

const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0, 0] as const;
const EXIF_SCAN_HEAD_BYTES = 32 * 1024 * 1024;
const EXIF_SCAN_TAIL_BYTES = 8 * 1024 * 1024;

function findExifOffsets(bytes: Uint8Array, absoluteStart: number): number[] {
  const offsets: number[] = [];
  for (let i = 0; i <= bytes.length - EXIF_SIGNATURE.length; i++) {
    let matches = true;
    for (let j = 0; j < EXIF_SIGNATURE.length; j++) {
      if (bytes[i + j] !== EXIF_SIGNATURE[j]) { matches = false; break; }
    }
    if (matches) offsets.push(absoluteStart + i + EXIF_SIGNATURE.length);
    if (offsets.length >= 8) break;
  }
  return offsets;
}

/** Some HIF and proprietary RAW containers carry a valid EXIF/TIFF payload
 * that their outer container parser does not expose. Parse that payload
 * directly before falling back to a costly RAW preview extraction. */
async function parseEmbeddedExifPayload(
  file: File,
  parse: (input: Blob, options: Record<string, unknown>) => Promise<unknown>,
  options: Record<string, unknown>,
): Promise<ExifTags | null> {
  const windows: Array<{ start: number; end: number }> = [
    { start: 0, end: Math.min(file.size, EXIF_SCAN_HEAD_BYTES) },
  ];
  if (file.size > EXIF_SCAN_HEAD_BYTES) {
    windows.push({ start: Math.max(EXIF_SCAN_HEAD_BYTES, file.size - EXIF_SCAN_TAIL_BYTES), end: file.size });
  }
  for (const window of windows) {
    const bytes = new Uint8Array(await file.slice(window.start, window.end).arrayBuffer());
    for (const offset of findExifOffsets(bytes, window.start)) {
      try {
        const parsed = normalizeExifTags(await parse(file.slice(offset), options) as Record<string, unknown> | null);
        if (parsed && (hasCaptureMetadata(parsed) || parsed.Make || parsed.Model)) return parsed;
      } catch {
        // A false-positive signature must not stop the next candidate.
      }
    }
  }
  return null;
}

/**
 * Read normal EXIF first. Proprietary RAW containers such as Fuji RAF are
 * not always recognized by exifr, but their embedded camera JPEG normally
 * carries the same exposure metadata. Use that JPEG as the local fallback;
 * the original RAW never leaves the browser.
 */
async function parseExifWithRawFallback(file: File): Promise<ExifTags | null> {
  const exifr = await import('exifr');
  // `tiff: true` enables every TIFF block, including IFD0, EXIF, GPS and IFD1.
  const options = { tiff: true, iptc: true } as const;
  let primary: ExifTags | null = null;
  try {
    primary = normalizeExifTags(await exifr.default.parse(file, options) as ExifTags | null);
  } catch {
    // Try an embedded TIFF payload / RAW preview below.
  }

  if (!hasCaptureMetadata(primary) && !primary?.Make && !primary?.Model) {
    const embeddedPayload = await parseEmbeddedExifPayload(
      file,
      (input, parseOptions) => exifr.default.parse(input, parseOptions),
      options,
    );
    primary = mergeDefined(primary, embeddedPayload);
  }
  if (!RawDecoder.isRawFile(file.name) || hasCaptureMetadata(primary)) return normalizeExifTags(primary);

  const embedded = await rawDecoder.extractLargestEmbeddedJpeg(file);
  if (!embedded) return primary;
  try {
    const fallback = normalizeExifTags(await exifr.default.parse(embedded, options) as ExifTags | null);
    return normalizeExifTags(mergeDefined(primary, fallback));
  } catch {
    return primary;
  }
}

export interface ExifData {
  fileName: string;
  fileSize: number;
  dimensions: { width: number; height: number };
  mimeType: string;
  make?: string;
  model?: string;
  lens?: string;
  exposureTime?: string;
  fNumber?: number;
  iso?: number;
  focalLength?: number;
  dateTime?: Date;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  keywords?: string[];
  copyright?: string;
  description?: string;
}

/**
 * The EXIF a remote library already told us about, straight from the catalogue
 * row the scan wrote.
 *
 * For a source whose bytes live on a server, reading EXIF out of the file
 * means downloading the original - 20-60 MB for a RAW - for nine lines of
 * text. The scan already read those nine lines once. Fields the scan never
 * recorded stay undefined here rather than being guessed from a display
 * rendition: that rendition is a different picture than the original.
 */
export function exifFromCatalog(photo: PhotoView): ExifData {
  return {
    fileName: photo.name,
    fileSize: photo.sizeBytes ?? 0,
    dimensions: { width: photo.width ?? 0, height: photo.height ?? 0 },
    mimeType: photo.mimeType ?? 'unknown',
    model: photo.camera ?? undefined,
    lens: photo.lens ?? undefined,
    iso: photo.iso ?? undefined,
    focalLength: photo.focalLength ?? undefined,
    fNumber: photo.aperture ?? undefined,
    exposureTime: photo.shutterSpeed ?? undefined,
    dateTime: photo.dateTaken !== null ? new Date(photo.dateTaken) : undefined,
    latitude: photo.latitude ?? undefined,
    longitude: photo.longitude ?? undefined,
    keywords: photo.keywords.length > 0 ? photo.keywords : undefined,
  };
}

export function useExif(file: File | null): ExifData | null {
  const [data, setData] = useState<ExifData | null>(null);

  useEffect(() => {
    if (!file) { setData(null); return; }
    let cancelled = false;

    async function parse() {
      try {
        const raw = await parseExifWithRawFallback(file!);

        if (cancelled) return;

        // Get image dimensions
        let width = raw?.ImageWidth ?? raw?.ExifImageWidth ?? 0;
        let height = raw?.ImageHeight ?? raw?.ExifImageHeight ?? 0;
        if (!width || !height) {
          const dims = await readImageDimensions(file!);
          if (dims) { width = dims.w; height = dims.h; }
        }

        setData({
          fileName: file!.name,
          fileSize: file!.size,
          dimensions: { width, height },
          mimeType: file!.type || 'unknown',
          make: raw?.Make,
          model: raw?.Model,
          lens: raw?.LensModel ?? raw?.Lens,
          exposureTime: raw?.ExposureTime
            ? (raw.ExposureTime < 1 ? `1/${Math.round(1 / raw.ExposureTime)}` : `${raw.ExposureTime}`)
            : undefined,
          fNumber: raw?.FNumber,
          iso: raw?.ISO,
          focalLength: raw?.FocalLength,
          dateTime: raw?.DateTimeOriginal ?? raw?.CreateDate,
          latitude: raw?.latitude,
          longitude: raw?.longitude,
          altitude: raw?.GPSAltitude,
          keywords: raw?.Keywords ?? raw?.subject,
          copyright: raw?.Copyright,
          description: raw?.ImageDescription ?? raw?.Description,
        });
      } catch {
        if (!cancelled) {
          // Fallback: basic file info without EXIF — use header parser (no full decode)
          const dims = await readImageDimensions(file!);
          setData({
            fileName: file!.name,
            fileSize: file!.size,
            dimensions: { width: dims?.w ?? 0, height: dims?.h ?? 0 },
            mimeType: file!.type || 'unknown',
          });
        }
      }
    }

    parse();
    return () => { cancelled = true; };
  }, [file]);

  return data;
}

/** Extract EXIF data from a File and return fields for PhotoView.
 *  Pure function for use during source scanning — no React hooks. */
export async function extractExifForDb(file: File): Promise<Partial<PhotoView>> {
  try {
    const raw = await parseExifWithRawFallback(file);
    if (!raw) return {};

    let width = raw.ImageWidth ?? raw.ExifImageWidth ?? 0;
    let height = raw.ImageHeight ?? raw.ExifImageHeight ?? 0;
    if (!width || !height) {
      try {
        const bitmap = await createImageBitmap(file);
        width = bitmap.width; height = bitmap.height;
        bitmap.close();
      } catch { /* non-image files */ }
    }

    const make = raw.Make?.trim();
    const model = raw.Model?.trim();
    const camera = make && model
      ? (model.startsWith(make) ? model : `${make} ${model}`)
      : (model ?? make ?? null);

    return {
      camera,
      lens: raw.LensModel ?? raw.Lens ?? null,
      iso: raw.ISO ?? null,
      focalLength: raw.FocalLength ? Math.round(raw.FocalLength) : null,
      aperture: raw.FNumber ?? null,
      shutterSpeed: raw.ExposureTime
        ? (raw.ExposureTime < 1 ? `1/${Math.round(1 / raw.ExposureTime)}` : `${raw.ExposureTime}`)
        : null,
      width: width || null,
      height: height || null,
      keywords: raw.Keywords ?? raw.subject ?? [],
      latitude: raw.latitude ?? undefined,
      longitude: raw.longitude ?? undefined,
      dateTaken: raw.DateTimeOriginal
        ? new Date(raw.DateTimeOriginal).getTime()
        : (raw.CreateDate ? new Date(raw.CreateDate).getTime() : undefined),
    };
  } catch {
    return {};
  }
}
