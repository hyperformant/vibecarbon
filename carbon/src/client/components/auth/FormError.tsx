import type { ReactNode } from 'react';

/**
 * A form's error message, announced to screen readers (`role="alert"`). Used
 * by the auth forms, the two-factor code form and the Security settings.
 * Render it only while there is an error, so the announcement fires.
 */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
      {children}
    </div>
  );
}
