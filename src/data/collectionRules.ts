import type { CollectionRow, CollectionRule, PhotoView } from '../storage/repos';

export type CollectionRuleField = CollectionRule['field'];
export type CollectionRuleOperator = CollectionRule['operator'];

export const COLLECTION_RULE_FIELDS: readonly CollectionRuleField[] = [
  'rating', 'flag', 'colorLabel', 'camera', 'lens', 'date', 'iso', 'focalLength', 'keywords', 'mimeType',
];

const NUMBER_FIELDS = new Set<CollectionRuleField>(['rating', 'iso', 'focalLength']);
const TEXT_FIELDS = new Set<CollectionRuleField>(['camera', 'lens', 'keywords', 'mimeType']);
const ORDERED_OPERATORS: readonly CollectionRuleOperator[] = [
  'equals', 'contains', 'greaterThan', 'lessThan', 'between',
];
const FLAGS = new Set(['', 'pick', 'reject']);
const COLOR_LABELS = new Set(['', 'red', 'yellow', 'green', 'blue', 'purple']);

export function operatorsForCollectionField(field: CollectionRuleField): readonly CollectionRuleOperator[] {
  if (NUMBER_FIELDS.has(field) || field === 'date') {
    return ['equals', 'greaterThan', 'lessThan', 'between'];
  }
  if (TEXT_FIELDS.has(field)) return ['equals', 'contains'];
  return ['equals'];
}

export function defaultCollectionRule(field: CollectionRuleField = 'rating'): CollectionRule {
  const value = field === 'date' ? '' : NUMBER_FIELDS.has(field) ? 0 : '';
  return { field, operator: 'equals', value };
}

/**
 * Validate the JSON boundary shared by catalog persistence and sync.
 * An explicit empty array is valid and means match-all; every other malformed
 * payload stays distinguishable from it so it can fail closed.
 */
export function validCollectionRules(rules: unknown): CollectionRule[] | null {
  if (!Array.isArray(rules) || !rules.every(isCollectionRule)) return null;
  return rules;
}

export function matchesCollectionRules(photo: PhotoView, rules: unknown): boolean {
  const valid = validCollectionRules(rules);
  return valid !== null && valid.every((rule) => matchesCollectionRule(photo, rule));
}

export function filterPhotosByCollection(
  photos: readonly PhotoView[],
  collections: readonly CollectionRow[],
  activeCollectionId: number,
): PhotoView[] {
  const relevantIds = new Set<number>();
  const visit = (id: number) => {
    if (relevantIds.has(id)) return;
    relevantIds.add(id);
    for (const collection of collections) {
      if (collection.parentId === id) visit(collection.id);
    }
  };
  visit(activeCollectionId);

  const relevant = collections.filter((collection) => relevantIds.has(collection.id));
  const manualIds = new Set<number>();
  const smartRules: unknown[] = [];
  for (const collection of relevant) {
    if (collection.type === 'manual') {
      for (const id of collection.photoIds ?? []) manualIds.add(id);
    } else if (collection.type === 'smart') {
      smartRules.push(collection.rules);
    }
  }

  return photos.filter((photo) => manualIds.has(photo.id)
    || smartRules.some((rules) => matchesCollectionRules(photo, rules)));
}

function matchesCollectionRule(photo: PhotoView, rule: CollectionRule): boolean {
  const actual = fieldValue(photo, rule.field);
  if (rule.operator === 'contains') {
    const expected = textValue(rule.value);
    if (!expected) return false;
    if (Array.isArray(actual)) return actual.some((value) => value.toLowerCase().includes(expected));
    return typeof actual === 'string' && actual.toLowerCase().includes(expected);
  }

  if (NUMBER_FIELDS.has(rule.field)) {
    return compareOrdered(actual, rule);
  }
  if (rule.field === 'date') {
    return compareDate(actual, rule);
  }
  if (rule.operator !== 'equals') return false;

  const expected = textValue(rule.value);
  if (!expected && rule.field !== 'flag' && rule.field !== 'colorLabel') return false;
  if (Array.isArray(actual)) return actual.some((value) => value.toLowerCase() === expected);
  return typeof actual === 'string' && actual.toLowerCase() === expected;
}

function compareOrdered(actual: unknown, rule: CollectionRule): boolean {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  const expected = finiteNumber(rule.value);
  if (expected === null) return false;
  switch (rule.operator) {
    case 'equals': return actual === expected;
    case 'greaterThan': return actual > expected;
    case 'lessThan': return actual < expected;
    case 'between': {
      const upper = finiteNumber(rule.value2);
      return upper !== null && actual >= Math.min(expected, upper) && actual <= Math.max(expected, upper);
    }
    default: return false;
  }
}

function compareDate(actual: unknown, rule: CollectionRule): boolean {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  const expected = dateValue(rule.value);
  if (expected === null) return false;
  const actualDay = utcDayStart(actual);
  switch (rule.operator) {
    case 'equals': return actualDay === expected;
    case 'greaterThan': return actualDay > expected;
    case 'lessThan': return actualDay < expected;
    case 'between': {
      const upper = dateValue(rule.value2);
      return upper !== null && actualDay >= Math.min(expected, upper) && actualDay <= Math.max(expected, upper);
    }
    default: return false;
  }
}

function fieldValue(photo: PhotoView, field: CollectionRuleField): string | number | string[] | null {
  switch (field) {
    case 'rating': return photo.rating ?? 0;
    case 'flag': return photo.flag ?? '';
    case 'colorLabel': return photo.colorLabel ?? '';
    case 'camera': return photo.camera ?? '';
    case 'lens': return photo.lens ?? '';
    case 'date': return photo.dateTaken;
    case 'iso': return photo.iso;
    case 'focalLength': return photo.focalLength;
    case 'keywords': return photo.keywords ?? [];
    case 'mimeType': return photo.mimeType ?? '';
  }
}

function textValue(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value ?? '').trim().toLowerCase();
}

function finiteNumber(value: unknown): number | null {
  if (value === '' || value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateValue(value: unknown): number | null {
  if (typeof value === 'number') {
    const day = utcDayStart(value);
    return Number.isFinite(day) ? day : null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null;
}

function utcDayStart(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isCollectionRule(value: unknown): value is CollectionRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.field !== 'string' || !COLLECTION_RULE_FIELDS.includes(candidate.field as CollectionRuleField)) {
    return false;
  }
  if (typeof candidate.operator !== 'string' || !ORDERED_OPERATORS.includes(candidate.operator as CollectionRuleOperator)) {
    return false;
  }
  const field = candidate.field as CollectionRuleField;
  const operator = candidate.operator as CollectionRuleOperator;
  if (!operatorsForCollectionField(field).includes(operator)) return false;
  if (!validValueForField(field, candidate.value)) return false;
  return operator !== 'between' || validValueForField(field, candidate.value2);
}

function validValueForField(field: CollectionRuleField, value: unknown): boolean {
  if (field === 'flag') return typeof value === 'string' && FLAGS.has(value);
  if (field === 'colorLabel') return typeof value === 'string' && COLOR_LABELS.has(value);
  if (NUMBER_FIELDS.has(field)) {
    if (value === '') return true; // An unfinished number input remains editable but never matches.
    const number = finiteNumber(value);
    if (number === null || number < 0) return false;
    return field !== 'rating' || number <= 5;
  }
  if (field === 'date') return value === '' || dateValue(value) !== null;
  return typeof value === 'string';
}
