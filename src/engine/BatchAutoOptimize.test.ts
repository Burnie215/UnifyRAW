import { describe, expect, it } from 'vitest';
import {
  AutoOptimizeEtaEstimator,
  autoOptimizeFileType,
  formatAutoOptimizeEta,
  orderForEtaCalibration,
} from './BatchAutoOptimize';

describe('batch auto optimization ETA', () => {
  it('uses separate running means for each file extension', () => {
    const estimator = new AutoOptimizeEtaEstimator();
    estimator.record('raf', 8_000);
    estimator.record('raf', 10_000);
    estimator.record('jpg', 1_000);

    expect(estimator.meanFor('raf')).toBe(9_000);
    expect(estimator.estimateRemaining(['raf', 'jpg', 'raf'])).toBe(19_000);
  });

  it('calibrates every file type before processing the remaining files', () => {
    const items = [
      { name: 'one.RAF' }, { name: 'two.RAF' }, { name: 'one.JPG' },
      { name: 'three.RAF' }, { name: 'one.HIF' }, { name: 'two.JPG' },
    ];
    expect(orderForEtaCalibration(items).map((item) => item.name)).toEqual([
      'one.RAF', 'one.JPG', 'one.HIF', 'two.RAF', 'three.RAF', 'two.JPG',
    ]);
  });

  it('derives a stable type and formats compact durations', () => {
    expect(autoOptimizeFileType({ name: 'without-extension', mimeType: 'image/jpeg' })).toBe('jpeg');
    expect(formatAutoOptimizeEta(61_000)).toBe('1 Min. 1 Sek.');
  });
});
