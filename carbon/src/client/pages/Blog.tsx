import { IconUser as User } from '@tabler/icons-react';
import { useParams } from 'react-router';
import { ContentEntry, ContentIndex } from '@/components/ContentCollection';
import { PROJECT_DISPLAY_NAME } from '@/components/Logo';
import { getPost, type BlogPost as Post, posts } from '@/lib/blog';

function renderAuthor(post: Post) {
  return (
    post.frontmatter.author && (
      <span className="flex items-center gap-1">
        <User className="size-3.5" />
        {post.frontmatter.author}
      </span>
    )
  );
}

export function BlogIndex() {
  return (
    <ContentIndex
      basePath="/blog"
      title="Blog"
      tagline="Updates, guides, and insights from the team."
      seoDescription={`Latest updates and guides from ${PROJECT_DISPLAY_NAME}.`}
      items={posts}
      emptyText="No posts yet. Check back soon!"
      renderMeta={renderAuthor}
    />
  );
}

export function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  return (
    <ContentEntry
      basePath="/blog"
      item={slug ? getPost(slug) : undefined}
      notFoundText="Post not found"
      backLabel="Back to blog"
      allLabel="All posts"
      renderMeta={renderAuthor}
    />
  );
}

/** Default export for React.lazy() route-level code splitting */
export default function BlogRoute() {
  const { slug } = useParams<{ slug: string }>();
  return slug ? <BlogPost /> : <BlogIndex />;
}
