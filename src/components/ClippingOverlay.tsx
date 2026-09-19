import { useEffect, useRef } from 'react';

/** Blue for crushed shadows, red for blown highlights. Reads rendered engine pixels only. */
export function ClippingOverlay({ source, renderGeneration, showShadows, showHighlights }: {
  source: HTMLCanvasElement | null;
  renderGeneration: number;
  showShadows: boolean;
  showHighlights: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source || (!showShadows && !showHighlights) || !source.width || !source.height) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const scale = Math.min(1, 800 / Math.max(source.width, source.height));
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const width = canvas.width;
    const height = canvas.height;

    context.clearRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    const overlay = context.createImageData(width, height);
    const output = overlay.data;
    for (let i = 0; i < data.length; i += 4) {
      const red = data[i], green = data[i + 1], blue = data[i + 2];
      if (showShadows && red < 8 && green < 8 && blue < 8) {
        output[i] = 50; output[i + 1] = 100; output[i + 2] = 255; output[i + 3] = 180;
      } else if (showHighlights && red > 248 && green > 248 && blue > 248) {
        output[i] = 255; output[i + 1] = 50; output[i + 2] = 50; output[i + 3] = 180;
      }
    }
    context.clearRect(0, 0, width, height);
    context.putImageData(overlay, 0, 0);
  }, [source, renderGeneration, showShadows, showHighlights]);

  return <canvas ref={canvasRef} className="clipping-overlay" data-render-generation={renderGeneration} />;
}
