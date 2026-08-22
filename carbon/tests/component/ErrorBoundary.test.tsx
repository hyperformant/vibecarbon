import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// React's default rendering logs the caught error to console.error in dev,
// which clutters test output but isn't an assertion failure. Silence it for
// the error path only.
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

function Boom(): never {
  throw new Error('kaboom');
}

describe('<ErrorBoundary />', () => {
  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <p>healthy</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('renders the fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument();
  });

  it('logs the caught error so it surfaces in observability', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    // Two console.error calls land here: one from React's own dev warning,
    // and one from ErrorBoundary.componentDidCatch. Assert ours is present.
    const fromBoundary = errorSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('ErrorBoundary caught an error'),
    );
    expect(fromBoundary).toBeDefined();
  });
});
