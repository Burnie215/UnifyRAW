import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetadataPanel } from './MetadataPanel';
import type { ExifData } from '../hooks/useExif';

// No i18n instance is initialised here, so t() hands back the key itself -
// which is exactly what we want to assert on: the label is wired, the value
// is formatted.
const base: ExifData = {
  fileName: 'DSC_0001.NEF',
  fileSize: 1024,
  dimensions: { width: 6000, height: 4000 },
  mimeType: 'image/x-nikon-nef',
};

function markup(exif: ExifData): string {
  return renderToStaticMarkup(createElement(MetadataPanel, { exif }));
}

describe('MetadataPanel', () => {
  it('shows altitude in the GPS block and the description as its own row', () => {
    const html = markup({
      ...base,
      latitude: 52.5163,
      longitude: 13.3777,
      altitude: 512.4,
      description: 'Probe',
    });

    expect(html).toContain('panels.metadata.altitude');
    expect(html).toContain('512 m');
    expect(html).toContain('panels.metadata.description');
    expect(html).toContain('Probe');
  });

  it('leaves both rows out when the fields are absent', () => {
    const html = markup({ ...base, latitude: 52.5163, longitude: 13.3777 });

    expect(html).toContain('panels.metadata.gps');
    expect(html).not.toContain('panels.metadata.altitude');
    expect(html).not.toContain('panels.metadata.description');
  });

  it('keeps an altitude of 0 (sea level) visible', () => {
    const html = markup({ ...base, latitude: 0, longitude: 0, altitude: 0 });

    expect(html).toContain('panels.metadata.altitude');
    expect(html).toContain('0 m');
  });
});
