import type { ReactNode } from 'react';
import type { ExifData } from '../hooks/useExif';
import type { PhotoView } from '../storage/repos';
import { formatShutterSpeed } from './statusBarFormatting';
import './StatusBar.css';

interface StatusBarProps {
  exif: ExifData | null;
  fileName: string;
  zoom: number;
  photo?: Pick<PhotoView, 'aperture' | 'shutterSpeed' | 'iso'>;
  /** Display controls, shown left of the zoom percentage. */
  displayControls?: ReactNode;
}

/**
 * Left: what the camera did. Center: the file. Right: how it is being displayed.
 * The display controls sit here rather than in the top bar so that "how do I see
 * this" is bottom-right in the editor just like it is in the library.
 */
export function StatusBar({ exif, fileName, zoom, photo, displayControls }: StatusBarProps) {
  const aperture = exif?.fNumber ?? photo?.aperture ?? null;
  const shutterSpeed = formatShutterSpeed(exif?.exposureTime ?? photo?.shutterSpeed ?? undefined);
  const iso = exif?.iso ?? photo?.iso ?? null;

  return (
    <div className="status-bar">
      <div className="sb-left">
        {exif?.focalLength && <span className="sb-item">{exif.focalLength}mm</span>}
        {exif && (
          <span className="sb-item">{exif.dimensions.width} × {exif.dimensions.height}</span>
        )}
        {exif?.make && exif?.model && (
          <span className="sb-item">{exif.make} {exif.model}</span>
        )}
      </div>
      <div className="sb-center">
        <span className="sb-filename">{fileName}</span>
        <span className="sb-capture-settings">
          {aperture && <span>f/{aperture}</span>}
          {shutterSpeed && <span>{shutterSpeed}</span>}
          {iso && <span>ISO {iso}</span>}
        </span>
      </div>
      <div className="sb-right">
        {displayControls}
        <span className="sb-item sb-zoom">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  );
}
