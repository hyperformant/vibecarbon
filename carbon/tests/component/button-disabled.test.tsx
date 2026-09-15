import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from '@/components/ui/button';

// A disabled Button must *look* disabled. The base class list originally
// carried only `disabled:cursor-default`, so a disabled CTA was
// indistinguishable from a live one — the only tell was the mouse cursor.
// Every other ui/ primitive dims to opacity-50 and drops pointer events;
// Button follows suit.
describe('Button disabled state', () => {
  it('sets the native disabled attribute and dims the button', () => {
    render(<Button disabled>Get Fullerene</Button>);
    const button = screen.getByRole('button', { name: 'Get Fullerene' });
    expect(button).toBeDisabled();
    expect(button.className).toContain('disabled:opacity-50');
    expect(button.className).toContain('disabled:pointer-events-none');
  });

  it('leaves an enabled button interactive', () => {
    render(<Button>Get Fullerene</Button>);
    const button = screen.getByRole('button', { name: 'Get Fullerene' });
    expect(button).toBeEnabled();
    expect(button.className).toContain('cursor-pointer');
  });
});
