import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CollectionRow } from '../storage/repos';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CollectionsPanel } from './CollectionsPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function collection(rules: unknown = []): CollectionRow {
  return {
    id: 7,
    syncId: 'smart-7',
    name: 'Night shots',
    type: 'smart',
    parentId: null,
    rules: rules as CollectionRow['rules'],
    photoIds: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
}

function mount(rules: unknown, onUpdateSmartRules = vi.fn()) {
  host ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(host);
  const props = {
    collections: [collection(rules)],
    activeCollectionId: 7,
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onUpdateSmartRules,
  };
  act(() => root?.render(createElement(CollectionsPanel, props)));
  return props;
}

function changeSelect(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('CollectionsPanel smart collection editor', () => {
  it('creates a smart collection and selects the returned row for editing', () => {
    const props = mount([]);
    props.onAdd.mockReturnValue(23);

    act(() => host?.querySelector<HTMLButtonElement>('.col-add-btn')?.click());
    const name = host!.querySelector<HTMLInputElement>('.col-add-form input')!;
    changeInput(name, 'Five stars');
    const typeButtons = [...host!.querySelectorAll<HTMLButtonElement>('.col-type-btn')];
    act(() => typeButtons[1].click());
    act(() => host?.querySelector<HTMLButtonElement>('.col-confirm-btn')?.click());

    expect(props.onAdd).toHaveBeenCalledWith('Five stars', 'smart', undefined);
    expect(props.onSelect).toHaveBeenCalledWith(23);
  });

  it('adds, edits, and deletes rules through the persistence callback', () => {
    const update = vi.fn();
    mount([], update);
    expect(host?.querySelector('.col-rule-editor')).not.toBeNull();

    act(() => host?.querySelector<HTMLButtonElement>('.col-rule-add')?.click());
    expect(update).toHaveBeenLastCalledWith(7, [{ field: 'rating', operator: 'equals', value: 0 }]);

    mount([{ field: 'rating', operator: 'equals', value: 0 }], update);
    changeSelect(host!.querySelector<HTMLSelectElement>('.col-rule-field')!, 'iso');
    expect(update).toHaveBeenLastCalledWith(7, [{ field: 'iso', operator: 'equals', value: 0 }]);

    mount([{ field: 'iso', operator: 'equals', value: 0 }], update);
    changeSelect(host!.querySelector<HTMLSelectElement>('.col-rule-operator')!, 'greaterThan');
    expect(update).toHaveBeenLastCalledWith(7, [{ field: 'iso', operator: 'greaterThan', value: 0, value2: undefined }]);

    mount([{ field: 'iso', operator: 'greaterThan', value: 0 }], update);
    changeInput(host!.querySelector<HTMLInputElement>('.col-rule-value')!, '800');
    expect(update).toHaveBeenLastCalledWith(7, [{ field: 'iso', operator: 'greaterThan', value: 800 }]);

    mount([{ field: 'iso', operator: 'greaterThan', value: 800 }], update);
    act(() => host?.querySelector<HTMLButtonElement>('.col-rule-delete')?.click());
    expect(update).toHaveBeenLastCalledWith(7, []);
  });

  it('renders malformed saved rules safely and replaces them with a valid rule', () => {
    const update = vi.fn();
    mount({}, update);

    expect(host?.querySelector('.col-rule-invalid')).not.toBeNull();
    expect(host?.querySelector('.col-rule-field')).toBeNull();
    act(() => host?.querySelector<HTMLButtonElement>('.col-rule-add')?.click());
    expect(update).toHaveBeenLastCalledWith(7, [{ field: 'rating', operator: 'equals', value: 0 }]);

    expect(() => mount([null], update)).not.toThrow();
    expect(host?.querySelector('.col-rule-invalid')).not.toBeNull();
  });

  it('keeps selection and child controls as sibling buttons with native keyboard activation', async () => {
    const props = mount([]);
    const row = host!.querySelector<HTMLElement>('.col-item:not(button)')!;
    const selectButton = row.querySelector<HTMLButtonElement>(':scope > .col-select-btn')!;
    const deleteButton = row.querySelector<HTMLButtonElement>(':scope > .col-del-btn')!;

    expect(row.getAttribute('role')).toBeNull();
    expect(selectButton.tagName).toBe('BUTTON');
    expect(selectButton.querySelector('button, input, select, textarea, [tabindex]')).toBeNull();
    expect(deleteButton.parentElement).toBe(row);

    selectButton.focus();
    await act(async () => { await userEvent.keyboard('{Enter}'); });
    await act(async () => { await userEvent.keyboard('{Space}'); });
    expect(props.onSelect).toHaveBeenNthCalledWith(1, 7);
    expect(props.onSelect).toHaveBeenNthCalledWith(2, 7);

    props.onSelect.mockClear();
    act(() => deleteButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    act(() => deleteButton.click());
    expect(props.onSelect).not.toHaveBeenCalled();

    const name = row.querySelector<HTMLElement>('.col-name')!;
    act(() => name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const editor = row.querySelector<HTMLInputElement>('.col-name-input')!;
    expect(editor.parentElement).toBe(row);
    act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
