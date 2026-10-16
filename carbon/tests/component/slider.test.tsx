import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Slider } from '@/components/ui/slider';

// Two bugs made the admin Theme page's smooth-scroll slider dead to the mouse
// and to all but the first key press:
//  1. base-ui hands pointer drags and track presses a bare number for a
//     one-element `value={[n]}`, but the keyboard an array. Callers guard on
//     Array.isArray (Theme.tsx does), so every pointer change was dropped.
//  2. Each Thumb was keyed by its value, so every change remounted it and the
//     focused range input vanished after one step.
// The harness below mirrors Theme.tsx: it only accepts array values.

function ControlledSlider({ onChange }: { onChange: (v: number) => void }) {
  const [value, setValue] = useState(50);
  return (
    <>
      <Slider
        aria-label="Intensity"
        value={[value]}
        onValueChange={(next) => {
          if (!Array.isArray(next)) return;
          setValue(next[0]);
          onChange(next[0]);
        }}
        min={0}
        max={100}
        step={5}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

// thumbAlignment="edge" keeps the thumb visibility:hidden until it has measured
// real layout, which jsdom never provides, so query the range input directly.
const getThumb = () => screen.getByRole('slider', { hidden: true });

describe('Slider (controlled)', () => {
  it('keeps responding to ArrowRight across several steps', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledSlider onChange={onChange} />);

    const thumb = getThumb();
    thumb.focus();
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');

    expect(onChange.mock.calls.map((c) => c[0])).toEqual([55, 60, 65]);
    expect(screen.getByTestId('value')).toHaveTextContent('65');
    expect(getThumb()).toHaveFocus();
  });

  it('keeps the same thumb element mounted while the value changes', async () => {
    const user = userEvent.setup();
    render(<ControlledSlider onChange={() => {}} />);

    const before = getThumb();
    before.focus();
    await user.keyboard('{ArrowRight}');

    expect(getThumb()).toBe(before);
  });

  it('moves to a track press and follows a pointer drag, as an array', () => {
    const onChange = vi.fn();
    const { container } = render(<ControlledSlider onChange={onChange} />);

    const control = container.querySelector('[data-base-ui-slider-control]') as HTMLElement;
    expect(control).not.toBeNull();
    // jsdom has no layout or pointer capture: give the control a 200px-wide box
    // at x = 0 and no-op capture so base-ui's drag handlers run.
    control.getBoundingClientRect = () =>
      ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 16, width: 200, height: 16 }) as DOMRect;
    control.setPointerCapture = () => {};
    control.releasePointerCapture = () => {};
    control.hasPointerCapture = () => false;

    fireEvent.pointerDown(control, { button: 0, buttons: 1, clientX: 20, clientY: 8, pointerId: 1 });
    fireEvent.pointerMove(document, { buttons: 1, clientX: 60, clientY: 8, pointerId: 1 });
    fireEvent.pointerMove(document, { buttons: 1, clientX: 120, clientY: 8, pointerId: 1 });
    fireEvent.pointerMove(document, { buttons: 1, clientX: 180, clientY: 8, pointerId: 1 });
    fireEvent.pointerUp(document, { button: 0, clientX: 180, clientY: 8, pointerId: 1 });

    const seen = onChange.mock.calls.map((c) => c[0]);
    // Track press at 20/200 lands on 10, then the drag walks right.
    expect(seen[0]).toBe(10);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.at(-1)).toBe(90);
    expect(screen.getByTestId('value')).toHaveTextContent(String(seen.at(-1)));
  });
});
