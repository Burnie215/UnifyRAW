import type { PhotoView } from '../../storage/repos';
import type { SourceProvider } from '../../sources/types';
import {
  getSmartPreviewSize,
  loadRawPixels,
  type RawDecodeResult,
} from '../../engine/raw';
import type { RawLoadStage } from '../../engine/raw/RawDecoderStrategy';

type BenchRawProvider = Pick<
  SourceProvider,
  'type' | 'getFile' | 'getRemoteFetchHint' | 'getRawPreviewHint'
>;

export function loadBenchRaw(
  photo: PhotoView,
  provider: BenchRawProvider,
  signal: AbortSignal,
  onStage?: (stage: RawLoadStage) => void,
): Promise<RawDecodeResult | null> {
  const ref = {
    sourcePhotoId: photo.sourcePhotoId,
    sourceId: photo.sourceId,
    name: photo.name,
  };
  return loadRawPixels({
    identity: photo,
    size: getSmartPreviewSize(),
    sourceType: provider.type,
    file: (fileSignal) => provider.getFile(ref, fileSignal),
    fetchHint: provider.getRemoteFetchHint?.(ref) ?? null,
    preparedUrl: provider.getRawPreviewHint?.(ref)?.url ?? null,
    signal,
    onStage,
  });
}
