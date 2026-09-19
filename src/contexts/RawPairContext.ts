import { createContext, useContext } from 'react';
import { EMPTY_RAW_PAIR_INDEX, type RawPairIndex } from '../data/rawPairing';

/**
 * The RAW+JPEG pairs currently in effect, or an empty index while grouping is
 * off. Provided instead of drilled: the grid tiles are four components deep and
 * only need to know whether the photo they render stands for two files.
 */
const RawPairContext = createContext<RawPairIndex>(EMPTY_RAW_PAIR_INDEX);

export const RawPairProvider = RawPairContext.Provider;

export function useRawPairIndex(): RawPairIndex {
  return useContext(RawPairContext);
}
