/**
 * useGitHubStars - live star count for the repo configured via
 * VITE_GITHUB_REPO_URL.
 *
 * DEFAULT OFF. A generated app ships with no repo URL configured, so the
 * button renders nothing and NOTHING is fetched — a customer's site must
 * never phone home to GitHub on every visitor pageload (this exact fetch
 * was removed once before as vendor-specific and a privacy leak; the
 * contract lives in tests/component/nav-no-phone-home.test.tsx).
 * vibecarbon.com opts in by setting VITE_GITHUB_REPO_URL to its public
 * repo.
 *
 * Fetched client-side from the GitHub REST API (allowed in the CSP
 * connect-src). Consumers should render gracefully without a count —
 * the API is rate-limited to 60 unauthenticated requests/hour per IP.
 */

import { useQuery } from '@tanstack/react-query';

/** Read at call time (not module load) so tests can stub the env. */
export function getGitHubRepoUrl(): string {
  return (import.meta.env.VITE_GITHUB_REPO_URL as string | undefined) ?? '';
}

function apiUrlFor(repoUrl: string): string | null {
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  return m ? `https://api.github.com/repos/${m[1]}/${m[2]}` : null;
}

async function fetchGitHubStars(apiUrl: string): Promise<number> {
  const response = await fetch(apiUrl);

  if (!response.ok) {
    throw new Error('Failed to fetch GitHub repo info');
  }

  const data = (await response.json()) as { stargazers_count?: number };
  if (typeof data.stargazers_count !== 'number') {
    throw new Error('Missing stargazers_count in GitHub response');
  }
  return data.stargazers_count;
}

export const gitHubStarsQueryKey = ['github', 'stars'] as const;

export function useGitHubStars() {
  const apiUrl = apiUrlFor(getGitHubRepoUrl());
  return useQuery({
    queryKey: gitHubStarsQueryKey,
    queryFn: () => fetchGitHubStars(apiUrl as string),
    // The gate: no configured repo, no request — ever.
    enabled: apiUrl !== null,
    staleTime: 60 * 60 * 1000, // 1 hour - star counts move slowly
    gcTime: 2 * 60 * 60 * 1000,
    retry: false, // don't burn the unauthenticated rate limit on retries
    refetchOnWindowFocus: false,
  });
}
