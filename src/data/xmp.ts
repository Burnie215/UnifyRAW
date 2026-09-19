/**
 * The one XMP mapping: Adjustments -> Adobe `crs:` attributes. Every number
 * comes from crsScale.ts, and the matching reader is `parseLightroomPreset`
 * in lightroomPreset.ts, so a file written here reads back into the same
 * values (src/data/xmp.test.ts pins that round trip).
 *
 * The same packet is what an exported image carries, and there it also holds
 * the optional {@link XmpLink} back to the original. The sidecar download is
 * written without one - it describes an edit, not a particular file.
 */

import type { Adjustments, CurvePoint, HSLChannel } from '../types';
import { defaultAdjustments } from '../types';
import { CRS_FIELDS, COLOR_GRADE_SCALE, CURVE_CALIBRATION, HSL_SCALE, clamp } from './crsScale';
import { deliverFile } from '../platform/fileDelivery';

const HSL_CHANNELS: HSLChannel[] = [
  'red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta',
];

const COLOR_GRADE_ZONES = [
  ['Shadow', 'shadows'], ['Midtone', 'midtones'], ['Highlight', 'highlights'],
] as const;

function crsChannel(channel: HSLChannel): string {
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function sameCurve(a: readonly CurvePoint[], b: readonly CurvePoint[]): boolean {
  return a.length === b.length && a.every((point, index) =>
    point.x === b[index].x && point.y === b[index].y);
}

/**
 * The link back to what this file came from. Written next to the `crs:`
 * adjustments so an exported image carries both what was done and to what -
 * `dc:source` in Dublin Core, the two hashes in UnifyRAW's own namespace
 * because no standard one describes an edit stack.
 */
export interface XmpLink {
  /** `dc:source`, built by {@link originalSourceUri}. */
  source?: string | null;
  /** `unifyraw:editStackHash` - the full hash of the edit that produced this file. */
  editStackHash?: string | null;
  /** `unifyraw:originalChecksum` - the original's content hash. */
  originalChecksum?: string | null;
}

export const UNIFYRAW_XMP_NS = 'http://ns.unifyraw.com/1.0/';

/** The original's stable address: which source, which asset in it. */
export function originalSourceUri(sourceId: string, assetId: string): string {
  return `unifyraw://source/${encodeURIComponent(sourceId)}/asset/${encodeURIComponent(assetId)}`;
}

/** XML attribute values are the one place this file takes outside strings. */
function xmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function adjustmentsToXMP(adj: Adjustments, link?: XmpLink): string {
  const attrs: string[] = [];
  const push = (name: string, value: string | number) => attrs.push(`   crs:${name}="${value}"`);

  let customWhiteBalance = false;
  for (const field of CRS_FIELDS) {
    const value = (adj as unknown as Record<string, unknown>)[field.key];
    const fallback = (defaultAdjustments as unknown as Record<string, unknown>)[field.key];
    if (typeof value !== 'number' || value === fallback) continue;
    push(field.crs, field.toCrs(value));
    if (field.key === 'temperature' || field.key === 'tint') customWhiteBalance = true;
  }
  // Without this Lightroom reads Temperature/Tint against the camera preset
  // instead of the written numbers.
  if (customWhiteBalance) push('WhiteBalance', 'Custom');

  if (adj.bwEnabled) {
    push('ConvertToGrayscale', 'True');
    for (const channel of HSL_CHANNELS) {
      const value = adj.bwMix[channel];
      if (value !== defaultAdjustments.bwMix[channel]) {
        push(`GrayMixer${crsChannel(channel)}`, clamp(value, -100, 100));
      }
    }
  }

  for (const channel of HSL_CHANNELS) {
    const zone = adj.hsl[channel];
    const fallback = defaultAdjustments.hsl[channel];
    const suffix = crsChannel(channel);
    const bound = 100 / HSL_SCALE;
    if (zone.hue !== fallback.hue) {
      push(`HueAdjustment${suffix}`, clamp(zone.hue / HSL_SCALE, -bound, bound));
    }
    if (zone.saturation !== fallback.saturation) {
      push(`SaturationAdjustment${suffix}`, clamp(zone.saturation / HSL_SCALE, -bound, bound));
    }
    if (zone.luminance !== fallback.luminance) {
      push(`LuminanceAdjustment${suffix}`, clamp(zone.luminance / HSL_SCALE, -bound, bound));
    }
  }

  // ColorGrade*, not SplitToning*: the import prefers ColorGrade and only
  // falls back to SplitToning when none is present. `satAdj` has no crs
  // counterpart and is the one adjustment this export drops.
  const grading = adj.colorGrading;
  for (const [crsZone, zone] of COLOR_GRADE_ZONES) {
    const values = grading[zone];
    const fallback = defaultAdjustments.colorGrading[zone];
    if (values.hue !== fallback.hue) {
      push(`ColorGrade${crsZone}Hue`, clamp(values.hue, 0, 360));
    }
    if (values.saturation !== fallback.saturation) {
      const bound = 100 / COLOR_GRADE_SCALE.saturation;
      push(`ColorGrade${crsZone}Sat`, clamp(values.saturation / COLOR_GRADE_SCALE.saturation, 0, bound));
    }
    if (values.lumAdj !== fallback.lumAdj) {
      const bound = 100 / COLOR_GRADE_SCALE.lumAdj;
      push(`ColorGrade${crsZone}Lum`, clamp(values.lumAdj / COLOR_GRADE_SCALE.lumAdj, -bound, bound));
    }
  }
  if (grading.blending !== defaultAdjustments.colorGrading.blending) {
    push('ColorGradeBlending', clamp(grading.blending, 0, 100));
  }
  if (grading.balance !== defaultAdjustments.colorGrading.balance) {
    push('ColorGradeBalance', clamp(grading.balance, -100, 100));
  }

  if (adj.flipH) push('FlipHorizontal', 'True');
  if (adj.flipV) push('FlipVertical', 'True');

  const children: string[] = [];
  if (!sameCurve(adj.toneCurve.rgb, defaultAdjustments.toneCurve.rgb)) {
    // The import calibrates every curve it reads by CURVE_CALIBRATION
    // (lightroomPreset.calibrateCurve) and sets toneCurveSpace 'gamma';
    // writing the inverse here is what makes the round trip exact. A curve
    // authored with toneCurveSpace 'linear' therefore reads back shifted.
    const points = adj.toneCurve.rgb.map(({ x, y }) => {
      const lightroomY = x + (y - x) / CURVE_CALIBRATION;
      return `     <rdf:li>${clamp(x * 255, 0, 255)}, ${clamp(lightroomY * 255, 0, 255)}</rdf:li>`;
    });
    children.push(
      '   <crs:ToneCurvePV2012>',
      '    <rdf:Seq>',
      ...points,
      '    </rdf:Seq>',
      '   </crs:ToneCurvePV2012>',
    );
  }

  const linkAttrs: string[] = [];
  const pushLink = (name: string, value: string | null | undefined) => {
    if (typeof value === 'string' && value.length > 0) {
      linkAttrs.push(`   ${name}="${xmlAttribute(value)}"`);
    }
  };
  pushLink('dc:source', link?.source);
  pushLink('unifyraw:editStackHash', link?.editStackHash);
  pushLink('unifyraw:originalChecksum', link?.originalChecksum);

  const description = [
    '  <rdf:Description rdf:about=""',
    '   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
    ...(linkAttrs.length > 0
      ? ['   xmlns:dc="http://purl.org/dc/elements/1.1/"', `   xmlns:unifyraw="${UNIFYRAW_XMP_NS}"`]
      : []),
    '   crs:Version="15.0"',
    '   crs:ProcessVersion="11.0"',
    ...linkAttrs,
    ...attrs,
    ...(children.length > 0 ? ['   >', ...children, '  </rdf:Description>'] : ['  />']),
  ];

  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${description.join('\n')}
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Hand an XMP sidecar for the given adjustments to the user, by whichever
 * route this shell has: a browser download, or a file the native share sheet
 * can pass on ({@link deliverFile}). The sidecar follows its image, so it has
 * to travel the same way.
 */
export async function downloadXMP(adjustments: Adjustments, photoName: string): Promise<void> {
  const xmp = adjustmentsToXMP(adjustments);
  const blob = new Blob([xmp], { type: 'application/rdf+xml' });
  const ext = photoName.lastIndexOf('.');
  const baseName = ext >= 0 ? photoName.slice(0, ext) : photoName;
  await deliverFile(blob, `${baseName}.xmp`);
}
