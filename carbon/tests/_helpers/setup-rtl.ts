// Vitest setupFile for the `component` project.
//
// 1. Loads @testing-library/jest-dom so matchers like .toBeInTheDocument()
//    are typed and available.
// 2. Runs RTL's cleanup() after each test so DOM state doesn't leak.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
