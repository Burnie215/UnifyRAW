import { describe, expect, it, vi } from 'vitest';
import { activityCounter } from './activityCounter';

describe('activityCounter', () => {
  it('stays busy until the last of two overlapping runs ends', () => {
    const onChange = vi.fn();
    const scans = activityCounter(onChange);
    scans.begin();
    scans.begin();
    scans.end();
    expect(onChange.mock.calls).toEqual([[true]]);
    scans.end();
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('ignores an end without a begin', () => {
    const onChange = vi.fn();
    const scans = activityCounter(onChange);
    scans.end();
    scans.begin();
    expect(onChange.mock.calls).toEqual([[true]]);
  });
});
