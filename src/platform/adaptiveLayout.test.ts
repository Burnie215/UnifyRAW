import { describe, expect, it } from 'vitest';
import { classifyDevice, resolveDeviceProfile } from './adaptiveLayout';

describe('classifyDevice', () => {
  it('classifies a desktop mouse viewport', () => {
    expect(classifyDevice({
      width: 1_440,
      height: 900,
      coarsePointer: false,
      hoverAvailable: true,
      maxTouchPoints: 0,
    })).toMatchObject({ screen: 'desktop', orientation: 'landscape', primaryInput: 'pointer' });
  });

  it('keeps a rotated phone in phone mode', () => {
    expect(classifyDevice({
      width: 844,
      height: 390,
      coarsePointer: true,
      hoverAvailable: false,
      maxTouchPoints: 5,
    })).toMatchObject({ screen: 'phone', orientation: 'landscape', primaryInput: 'touch' });
  });

  it('classifies tablet portrait and landscape viewports consistently', () => {
    const portrait = classifyDevice({
      width: 768,
      height: 1_024,
      coarsePointer: true,
      hoverAvailable: false,
      maxTouchPoints: 5,
    });
    const landscape = classifyDevice({
      width: 1_024,
      height: 768,
      coarsePointer: true,
      hoverAvailable: false,
      maxTouchPoints: 5,
    });
    expect(portrait).toMatchObject({ screen: 'tablet', orientation: 'portrait' });
    expect(landscape).toMatchObject({ screen: 'tablet', orientation: 'landscape' });
  });

  it('keeps a large touch display desktop-sized while enabling touch targets', () => {
    expect(classifyDevice({
      width: 1_920,
      height: 1_080,
      coarsePointer: true,
      hoverAvailable: false,
      maxTouchPoints: 10,
    })).toMatchObject({ screen: 'desktop', primaryInput: 'touch' });
  });
});

describe('resolveDeviceProfile', () => {
  const detected = classifyDevice({
    width: 1_440,
    height: 900,
    coarsePointer: false,
    hoverAvailable: true,
    maxTouchPoints: 0,
  });

  it('keeps the detected profile in automatic mode', () => {
    expect(resolveDeviceProfile(detected, 'auto')).toBe(detected);
  });

  it('forces phone and tablet previews to use touch input', () => {
    expect(resolveDeviceProfile(detected, 'phone')).toMatchObject({
      screen: 'phone', primaryInput: 'touch', coarsePointer: true, hoverAvailable: false,
    });
    expect(resolveDeviceProfile(detected, 'tablet')).toMatchObject({
      screen: 'tablet', primaryInput: 'touch', coarsePointer: true, hoverAvailable: false,
    });
  });

  it('forces only the shell when desktop mode is selected', () => {
    expect(resolveDeviceProfile({ ...detected, primaryInput: 'touch' }, 'desktop')).toMatchObject({
      screen: 'desktop', primaryInput: 'touch',
    });
  });
});
