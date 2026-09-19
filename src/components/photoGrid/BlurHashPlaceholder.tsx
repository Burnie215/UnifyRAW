import { useState, useEffect } from 'react';

const BLURHASH_CACHE_MAX = 200;
const blurHashCache = new Map<string, string>();

function blurHashCacheSet(key: string, value: string) {
  blurHashCache.set(key, value);
  if (blurHashCache.size > BLURHASH_CACHE_MAX) {
    const first = blurHashCache.keys().next().value;
    if (first !== undefined) blurHashCache.delete(first);
  }
}

export function BlurHashPlaceholder({ hash }: { hash: string }) {
  const [dataUrl, setDataUrl] = useState<string | undefined>(() => blurHashCache.get(hash));

  useEffect(() => {
    if (dataUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const { blurHashToDataURL } = await import('../../image/blurhash');
        const url = blurHashToDataURL(hash, 32, 32);
        if (!cancelled) {
          blurHashCacheSet(hash, url);
          setDataUrl(url);
        }
      } catch { /* invalid hash — skip silently */ }
    })();
    return () => { cancelled = true; };
  }, [hash, dataUrl]);

  return dataUrl
    ? <img src={dataUrl} alt="" className="grid-item-blurhash" />
    : <div className="grid-item-loading" />;
}
