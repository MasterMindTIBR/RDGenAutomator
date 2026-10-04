import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Checkbox, presetMetadata } from './shared';

describe('presetMetadata', () => {
  it('shows only version and connection direction', () => {
    expect(presetMetadata(3, 'Entrada')).toBe('v3 · Entrada');
    expect(presetMetadata(1, 'Ambas')).toBe('v1 · Ambas');
    expect(presetMetadata(2, 'Saída')).toBe('v2 · Saída');
  });
});

describe('Checkbox', () => {
  it('renders checked, unchecked and disabled states with the expected classes', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Checkbox checked={false} onChange={onChange} label="Opção" />);
    const input = screen.getByRole('checkbox') as HTMLInputElement;
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(false);
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<Checkbox checked={true} onChange={onChange} label="Opção" />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

    rerender(<Checkbox checked={true} onChange={onChange} label="Opção" disabled />);
    const disabled = screen.getByRole('checkbox') as HTMLInputElement;
    expect(disabled.disabled).toBe(true);
    expect(screen.getByText('Opção').closest('label')?.className).toContain('native-check-disabled');
    expect(screen.getByText('Opção').closest('label')?.className).toContain('native-check');
  });
});
