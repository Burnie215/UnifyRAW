import { createContext, useContext } from 'react';
import { EMPTY_STACK_INDEX, type StackIndex } from '../data/photoStacks';

export interface StackView {
  /** Every stack in the library, keyed by member id. */
  index: StackIndex;
  /** Stacks the user opened; these stay unfolded in the grid. */
  expanded: ReadonlySet<string>;
  /** Folds a stack open or shut again. */
  toggle: (stackId: string) => void;
}

const EMPTY_STACK_VIEW: StackView = {
  index: EMPTY_STACK_INDEX,
  expanded: new Set<string>(),
  toggle: () => {},
};

/**
 * The stacks currently in effect. Provided instead of drilled: the grid tiles
 * and list rows are several components deep and only need to know whether the
 * photo they render stands for a whole stack.
 */
const StackContext = createContext<StackView>(EMPTY_STACK_VIEW);

export const StackProvider = StackContext.Provider;

export function useStacks(): StackView {
  return useContext(StackContext);
}
