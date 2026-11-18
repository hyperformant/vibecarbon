import { IconTag as Tag } from '@tabler/icons-react';
import { useParams } from 'react-router';
import { ContentEntry as CollectionEntry, ContentIndex } from '@/components/ContentCollection';
import { PROJECT_DISPLAY_NAME } from '@/components/Logo';
import { type ChangelogEntry as Entry, entries, getEntry } from '@/lib/changelog';

function renderVersion(entry: Entry) {
  return (
    entry.frontmatter.version && (
      <span className="flex items-center gap-1">
        <Tag className="size-3.5" />v{entry.frontmatter.version}
      </span>
    )
  );
}

export function ChangelogIndex() {
  return (
    <ContentIndex
      basePath="/changelog"
      title="Changelog"
      tagline="New features, improvements, and fixes."
      seoDescription={`What's new in ${PROJECT_DISPLAY_NAME}.`}
      items={entries}
      emptyText="No changelog entries yet. Check back soon!"
      renderMeta={renderVersion}
    />
  );
}

export function ChangelogEntry() {
  const { slug } = useParams<{ slug: string }>();
  return (
    <CollectionEntry
      basePath="/changelog"
      item={slug ? getEntry(slug) : undefined}
      notFoundText="Entry not found"
      backLabel="Back to changelog"
      allLabel="All releases"
      renderMeta={renderVersion}
    />
  );
}

/** Default export for React.lazy() route-level code splitting */
export default function ChangelogRoute() {
  const { slug } = useParams<{ slug: string }>();
  return slug ? <ChangelogEntry /> : <ChangelogIndex />;
}
