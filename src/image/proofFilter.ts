import { convertPixel, type ColorSpaceId } from '../engine/ColorSpace';

export type ProofProfile = 'srgb' | 'adobe-rgb' | 'prophoto' | 'cmyk-fogra39' | 'cmyk-us-web-coated' | 'cmyk-japan-color';
export type PaperSimulation = 'none' | 'matte' | 'glossy' | 'fine-art' | 'canvas';

const PAPER_FILTERS: Record<PaperSimulation, string> = {
  none: '',
  matte: 'contrast(0.92) saturate(0.88) brightness(0.97)',
  glossy: 'contrast(1.02) saturate(0.95)',
  'fine-art': 'contrast(0.88) saturate(0.82) brightness(0.95)',
  canvas: 'contrast(0.85) saturate(0.78) brightness(0.93)',
};

/**
 * Get CSS filter approximation for soft proof profile + paper simulation.
 */
export function getProofFilter(profile: ProofProfile, paper: PaperSimulation = 'none'): string {
  let profileFilter: string;
  switch (profile) {
    case 'srgb':
      profileFilter = '';
      break;
    case 'adobe-rgb':
      profileFilter = 'saturate(0.92)';
      break;
    case 'prophoto':
      profileFilter = 'saturate(0.85) contrast(1.02)';
      break;
    case 'cmyk-fogra39':
      profileFilter = 'saturate(0.75) contrast(0.95) brightness(0.97)';
      break;
    case 'cmyk-us-web-coated':
      profileFilter = 'saturate(0.72) contrast(0.93) brightness(0.96)';
      break;
    case 'cmyk-japan-color':
      profileFilter = 'saturate(0.78) contrast(0.94) brightness(0.96)';
      break;
    default:
      profileFilter = '';
  }

  const paperFilter = PAPER_FILTERS[paper];
  return [profileFilter, paperFilter].filter(Boolean).join(' ');
}

/**
 * Map ProofProfile to ColorSpaceId for real gamut checks.
 */
function proofToColorSpace(profile: ProofProfile): ColorSpaceId | null {
  switch (profile) {
    case 'adobe-rgb': return 'adobe-rgb';
    case 'prophoto': return 'prophoto';
    default: return null;
  }
}

/**
 * Generate gamut warning overlay.
 * For RGB profiles: real roundtrip-clipping test via matrix conversion.
 * For CMYK: heuristic (saturated + bright = likely out of gamut).
 * Pixels outside the target gamut are marked magenta.
 */
export function generateGamutWarning(
  imageData: ImageData,
  profile: ProofProfile,
): ImageData {
  const { width, height, data } = imageData;
  const result = new ImageData(width, height);

  const targetCs = proofToColorSpace(profile);
  const isCmyk = profile.startsWith('cmyk');

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let outOfGamut = false;

    if (targetCs) {
      // sRGB → target → sRGB roundtrip: if clipping occurs, pixel is out of gamut
      const [cr, cg, cb] = convertPixel(r / 255, g / 255, b / 255, 'srgb', targetCs);
      const [rr, rg, rb] = convertPixel(cr, cg, cb, targetCs, 'srgb');
      const diff = Math.abs(rr - r / 255) + Math.abs(rg - g / 255) + Math.abs(rb - b / 255);
      outOfGamut = diff > 0.02;
    } else if (isCmyk) {
      const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      const bright = Math.max(r, g, b) / 255;
      outOfGamut = sat > 0.85 && bright > 0.7;
    }

    if (outOfGamut) {
      result.data[i] = 255;
      result.data[i + 1] = 0;
      result.data[i + 2] = 255;
      result.data[i + 3] = 180;
    } else {
      result.data[i + 3] = 0;
    }
  }

  return result;
}
