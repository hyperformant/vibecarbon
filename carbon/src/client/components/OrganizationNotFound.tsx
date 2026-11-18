import { useNavigate } from 'react-router';
import { ContentPanel } from '@/components/ContentPanel';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';

/** The whole page for an organization route whose id is not one of the user's organizations. */
export function OrganizationNotFound() {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Organization Not Found" />
      <ContentPanel variant="default">
        <p className="text-muted-foreground">
          The organization you're looking for doesn't exist or you don't have access.
        </p>
        <Button className="mt-4" onClick={() => navigate('/dashboard')}>
          Go to Dashboard
        </Button>
      </ContentPanel>
    </>
  );
}
