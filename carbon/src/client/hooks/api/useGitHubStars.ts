/**
 * useGitHubStars - Fetch the star count for the public Vibecarbon repo
 *
 * Fetched client-side from the GitHub REST API (allowed in the CSP
 * connect-src). Consumers should render gracefully without a count —
 * the API is rate-limited to 60 unauthenticated requests/hour per IP.
 */

import { useQuery } from '@tanstack/react-query';

export const GITHUB_REPO_URL = 'https://github.com/hyperformant/vibecarbon';

async function fetchGitHubStars(): Promise<number> {
  const response = await fetch('https://api.github.com/repos/hyperformant/vibecarbon');

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
  return useQuery({
    queryKey: gitHubStarsQueryKey,
    queryFn: fetchGitHubStars,
    staleTime: 60 * 60 * 1000, // 1 hour - star counts move slowly
    gcTime: 2 * 60 * 60 * 1000,
    retry: false, // don't burn the unauthenticated rate limit on retries
    refetchOnWindowFocus: false,
  });
}
