import { useEffect, useState } from 'react';

export type ScreenClass = 'phone' | 'tablet' | 'desktop';
export type ScreenOrientation = 'portrait' | 'landscape';
export type PrimaryInput = 'touch' | 'pointer';
export type AdaptiveUiMode = 'auto' | ScreenClass;

export interface DeviceProfile {
  screen: ScreenClass;
  orientation: ScreenOrientation;
  primaryInput: PrimaryInput;
  coarsePointer: boolean;
  hoverAvailable: boolean;
  width: number;
  height: number;
}

export interface DeviceSignals {
  width: number;
  height: number;
  coarsePointer: boolean;
  hoverAvailable: boolean;
  maxTouchPoints: number;
}

/**
 * Apply the user-facing UI preview mode without pretending the viewport has a
 * different size or orientation. Phone and tablet previews deliberately opt
 * into touch targets; a forced desktop keeps the device's actual input type.
 */
export function resolveDeviceProfile(
  detected: DeviceProfile,
  mode: AdaptiveUiMode,
): DeviceProfile {
  if (mode === 'auto') return detected;
  if (mode === 'desktop') return { ...detected, screen: mode };
  return {
    ...detected,
    screen: mode,
    primaryInput: 'touch',
    coarsePointer: true,
    hoverAvailable: false,
  };
}

/**
 * Classify the available viewport, not a user-agent string. The short-height
 * clause keeps a rotated phone in phone mode instead of turning it into a
 * tablet merely because its landscape width crosses the normal breakpoint.
 */
export function classifyDevice(signals: DeviceSignals): DeviceProfile {
  const { width, height, coarsePointer, hoverAvailable, maxTouchPoints } = signals;
  const orientation: ScreenOrientation = width >= height ? 'landscape' : 'portrait';
  const rotatedPhone = coarsePointer && height < 600 && width < 1_024;
  const screen: ScreenClass = width < 700 || rotatedPhone
    ? 'phone'
    : width < 1_180 || (coarsePointer && width <= 1_366)
      ? 'tablet'
      : 'desktop';
  const primaryInput: PrimaryInput = coarsePointer || (!hoverAvailable && maxTouchPoints > 0)
    ? 'touch'
    : 'pointer';

  return {
    screen,
    orientation,
    primaryInput,
    coarsePointer,
    hoverAvailable,
    width,
    height,
  };
}

function readDeviceProfile(): DeviceProfile {
  if (typeof window === 'undefined') {
    return classifyDevice({
      width: 1_440,
      height: 900,
      coarsePointer: false,
      hoverAvailable: true,
      maxTouchPoints: 0,
    });
  }

  return classifyDevice({
    width: window.innerWidth,
    height: window.innerHeight,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    hoverAvailable: window.matchMedia?.('(hover: hover)').matches ?? true,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
}

function profilesEqual(left: DeviceProfile, right: DeviceProfile): boolean {
  return left.screen === right.screen
    && left.orientation === right.orientation
    && left.primaryInput === right.primaryInput
    && left.coarsePointer === right.coarsePointer
    && left.hoverAvailable === right.hoverAvailable
    && left.width === right.width
    && left.height === right.height;
}

export function useDeviceProfile(): DeviceProfile {
  const [profile, setProfile] = useState(readDeviceProfile);

  useEffect(() => {
    const coarseQuery = window.matchMedia('(pointer: coarse)');
    const hoverQuery = window.matchMedia('(hover: hover)');
    let animationFrame: number | null = null;

    const update = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        const next = readDeviceProfile();
        setProfile((previous) => profilesEqual(previous, next) ? previous : next);
      });
    };

    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    coarseQuery.addEventListener?.('change', update);
    hoverQuery.addEventListener?.('change', update);
    update();

    return () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      coarseQuery.removeEventListener?.('change', update);
      hoverQuery.removeEventListener?.('change', update);
    };
  }, []);

  return profile;
}
