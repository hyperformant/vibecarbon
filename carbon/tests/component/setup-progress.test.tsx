import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSetupProgress, type SetupFlags } from '@/lib/setup-progress';

// The Overview setup stepper: every step is browsable. Hover previews a step in
// the Spotlight panel, click or Enter/Space selects it, and the selection
// sticks once the pointer leaves. The default selection is the current step.

const NOTHING_DONE: SetupFlags = {
  email: false,
  oauth: false,
  analytics: false,
  payments: false,
  deployed: false,
  billingOptOut: false,
};

const mutate = vi.fn();
let flags: SetupFlags = NOTHING_DONE;

vi.mock('@/hooks/api/useSetupStatus', () => ({
  useSetupStatus: () => ({
    progress: buildSetupProgress(flags),
    isLoading: false,
    isError: false,
    setBillingOptOut: { mutate, isPending: false },
  }),
}));

vi.mock('@/hooks/api', () => ({
  useDocsVisibility: () => ({ userDocsEnabled: true, apiDocsEnabled: true, isLoading: false }),
}));

const { SetupProgress } = await import('@/components/admin/SetupProgress');

function renderStepper(next: SetupFlags = NOTHING_DONE) {
  flags = next;
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
  return render(<SetupProgress />, { wrapper });
}

const stepButton = (label: RegExp) => screen.getByRole('button', { name: label });
const spotlight = () => screen.getByRole('complementary');
const eyebrow = () => screen.getByTestId('spotlight-eyebrow');
const rowOf = (label: RegExp) => stepButton(label).parentElement as HTMLElement;

describe('SetupProgress stepper', () => {
  beforeEach(() => mutate.mockReset());

  it('defaults to the current step with a "Next up" header', () => {
    renderStepper();
    expect(eyebrow()).toHaveTextContent('Next up · Step 3 of 7');
    expect(within(spotlight()).getByRole('heading', { name: 'Email' })).toBeInTheDocument();
    const email = stepButton(/Email/);
    expect(email).toHaveAttribute('aria-pressed', 'true');
    expect(email).toHaveAttribute('aria-current', 'step');
    expect(stepButton(/Payments/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('previews a hovered step and falls back when the pointer leaves', () => {
    renderStepper();
    fireEvent.mouseEnter(rowOf(/Payments/));
    expect(within(spotlight()).getByRole('heading', { name: 'Payments' })).toBeInTheDocument();
    expect(eyebrow()).toHaveTextContent(/^Step 6 of 7$/);
    // Hover is only a preview: the selection is unchanged.
    expect(stepButton(/Payments/)).toHaveAttribute('aria-pressed', 'false');

    fireEvent.mouseLeave(rowOf(/Payments/).parentElement as HTMLElement);
    expect(eyebrow()).toHaveTextContent('Next up · Step 3 of 7');
  });

  it('selects a step on click and keeps it after the pointer leaves', async () => {
    const user = userEvent.setup();
    renderStepper();
    await user.click(stepButton(/Analytics/));
    await user.unhover(stepButton(/Analytics/));

    expect(stepButton(/Analytics/)).toHaveAttribute('aria-pressed', 'true');
    expect(stepButton(/Email/)).toHaveAttribute('aria-pressed', 'false');
    expect(eyebrow()).toHaveTextContent(/^Step 5 of 7$/);
    // Integrations reset to the step's own list, first option picked.
    expect(within(spotlight()).getByRole('radio', { name: /Plausible/ })).toBeChecked();
  });

  it('selects a step from the keyboard with Enter and Space', async () => {
    const user = userEvent.setup();
    renderStepper();
    stepButton(/Social logins/).focus();
    await user.keyboard('{Enter}');
    expect(eyebrow()).toHaveTextContent(/^Step 4 of 7$/);
    expect(stepButton(/Social logins/)).toHaveAttribute('aria-pressed', 'true');

    stepButton(/Deploy/).focus();
    await user.keyboard(' ');
    expect(eyebrow()).toHaveTextContent(/^Step 7 of 7$/);
  });

  it('shows a done header with the command and integrations still browsable', async () => {
    const user = userEvent.setup();
    renderStepper({ ...NOTHING_DONE, email: true });
    await user.click(stepButton(/Email/));
    expect(eyebrow()).toHaveTextContent('✓ Done · Step 3 of 7');
    expect(within(spotlight()).getAllByRole('radio')).toHaveLength(4);
    expect(within(spotlight()).getByText('vibecarbon configure email resend')).toBeInTheDocument();
  });

  it('offers "Skip payments" only on the payments step', async () => {
    const user = userEvent.setup();
    renderStepper();
    expect(screen.queryByRole('button', { name: /Skip payments/ })).not.toBeInTheDocument();
    await user.click(stepButton(/Payments/));
    await user.click(screen.getByRole('button', { name: /Skip payments/ }));
    expect(mutate).toHaveBeenCalledWith(true);
  });

  it('keeps the panel when every step is complete, defaulting to deploy', async () => {
    const user = userEvent.setup();
    renderStepper({
      email: true,
      oauth: true,
      analytics: true,
      payments: false,
      deployed: true,
      billingOptOut: true,
    });
    expect(eyebrow()).toHaveTextContent('✓ Done · Step 7 of 7');
    await user.click(stepButton(/Payments/));
    expect(eyebrow()).toHaveTextContent('Skipped · Step 6 of 7');
    expect(screen.queryByRole('button', { name: /Skip payments/ })).not.toBeInTheDocument();
  });
});
