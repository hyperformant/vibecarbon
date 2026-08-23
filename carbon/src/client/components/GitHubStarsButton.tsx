import { IconBrandGithub as BrandGithub, IconStarFilled as StarFilled } from '@tabler/icons-react';
import { getGitHubRepoUrl, useGitHubStars } from '@/hooks/api';
import { Button } from './ui/button';

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact' });

/**
 * Header link to the configured GitHub repo with a live star count.
 * Gated on VITE_GITHUB_REPO_URL: a generated app configures no repo, so
 * this renders NOTHING and fetches nothing (see useGitHubStars — the
 * no-phone-home contract). Renders without the count until the fetch
 * lands (or if it fails).
 */
export function GitHubStarsButton({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const repoUrl = getGitHubRepoUrl();
  const { data: stars } = useGitHubStars();

  if (!repoUrl) return null;

  return (
    <Button variant="ghost" size={size} asChild>
      <a href={repoUrl} target="_blank" rel="noopener noreferrer" aria-label="GitHub repository">
        <BrandGithub className="size-4 shrink-0" />
        GitHub
        {stars !== undefined && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <StarFilled className="size-3 shrink-0" />
            {compactNumber.format(stars)}
          </span>
        )}
      </a>
    </Button>
  );
}
