import { useState, useCallback } from 'react';
import type { CropOverlayType } from '../components/CropOverlay';

/**
 * Manages crop tool state: crop mode, crop overlay type, spiral rotation,
 * straighten mode with line drawing, and rotation-triggered crop.
 */
export function useCropController() {
  const [cropMode, setCropMode] = useState(false);
  const [cropOverlay, setCropOverlay] = useState<CropOverlayType>('none');
  const [spiralRot, setSpiralRot] = useState(0);
  const [straightenMode, setStraightenMode] = useState(false);
  const [straightenStart, setStraightenStart] = useState<{ x: number; y: number } | null>(null);
  const [straightenEnd, setStraightenEnd] = useState<{ x: number; y: number } | null>(null);
  const [rotationCropActive, setRotationCropActive] = useState(false);

  const cycleCropOverlay = useCallback(() => {
    setCropOverlay((prev) => {
      const types: CropOverlayType[] = ['none', 'thirds', 'phi', 'spiral', 'diagonal', 'triangle'];
      return types[(types.indexOf(prev) + 1) % types.length];
    });
  }, []);

  const cycleSpiral = useCallback(() => {
    setSpiralRot((r) => (r + 1) % 4);
  }, []);

  const resetStraighten = useCallback(() => {
    setStraightenStart(null);
    setStraightenEnd(null);
    setStraightenMode(false);
  }, []);

  const activateRotationCrop = useCallback(() => {
    setRotationCropActive(true);
    setCropMode(true);
  }, []);

  return {
    cropMode, setCropMode,
    cropOverlay, cycleCropOverlay,
    spiralRot, cycleSpiral,
    straightenMode, setStraightenMode,
    straightenStart, setStraightenStart,
    straightenEnd, setStraightenEnd,
    rotationCropActive, setRotationCropActive,
    resetStraighten,
    activateRotationCrop,
  };
}
