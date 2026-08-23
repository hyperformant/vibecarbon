import { IconBrandGithub as BrandGithub, IconStarFilled as StarFilled } from '@tabler/icons-react';
import { GITHUB_REPO_URL, useGitHubStars } from '@/hooks/api';
import { Button } from './ui/button';

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact' });

/**
 * Header link to the public Vibecarbon repo with a live star count.
 * Renders without the count until the fetch lands (or if it fails).
 */
export function GitHubStarsButton({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const { data: stars } = useGitHubStars();

  return (
    <Button variant="ghost" size={size} asChild>
      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Vibecarbon on GitHub"
      >
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
