import {
  IconArchive as Archive,
  IconEye as Eye,
  IconLoader2 as Loader2,
  IconMail as Mail,
  IconMessage2 as MessageSquare,
  IconTrash as Trash2,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiJson } from '@/lib/api';
import { ContentPanel } from '../../components/ContentPanel';

interface ContactSubmission {
  id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  status: string;
  created_at: string;
}

const queryKey = ['admin', 'contact-submissions'];

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
    unread: 'default',
    read: 'secondary',
    replied: 'outline',
    archived: 'outline',
  };
  return <Badge variant={variants[status] || 'outline'}>{status}</Badge>;
}

export default function AdminContactSubmissions() {
  const queryClient = useQueryClient();
  const [selectedSubmission, setSelectedSubmission] = useState<ContactSubmission | null>(null);

  const { data, isLoading } = useQuery<{
    submissions: ContactSubmission[];
    total: number;
  }>({
    queryKey,
    queryFn: () =>
      apiJson<{ submissions: ContactSubmission[]; total: number }>(
        '/api/v1/admin/contact?limit=50',
        {},
        'Failed to fetch submissions'
      ),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiJson<void>(
        `/api/v1/admin/contact/${id}`,
        { method: 'PATCH', body: { status } },
        'Failed to update'
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiJson<void>(`/api/v1/admin/contact/${id}`, { method: 'DELETE' }, 'Failed to delete'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setSelectedSubmission(null);
      toast.success('Submission deleted');
    },
  });

  const submissions = data?.submissions ?? [];

  return (
    <>
      <PageHeader
        title="Contact Submissions"
        description={`${data?.total ?? 0} total submissions`}
      />

      <ContentPanel variant="default">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="size-5" />
              Submissions
            </CardTitle>
            <CardDescription>Contact form submissions from your website</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : submissions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No contact submissions yet.
              </p>
            ) : (
              <div className="space-y-2">
                {submissions.map((submission) => (
                  <div
                    key={submission.id}
                    className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => {
                      setSelectedSubmission(submission);
                      if (submission.status === 'unread') {
                        updateMutation.mutate({ id: submission.id, status: 'read' });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setSelectedSubmission(submission);
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-medium text-sm ${submission.status === 'unread' ? 'text-foreground' : 'text-muted-foreground'}`}
                        >
                          {submission.subject}
                        </span>
                        <StatusBadge status={submission.status} />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {submission.name} ({submission.email}) &middot;{' '}
                        {new Date(submission.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 ml-2">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          updateMutation.mutate({ id: submission.id, status: 'archived' });
                        }}
                      >
                        <Archive className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteMutation.mutate(submission.id);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </ContentPanel>

      {/* Submission detail dialog */}
      <Dialog open={!!selectedSubmission} onOpenChange={() => setSelectedSubmission(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedSubmission?.subject}</DialogTitle>
            <DialogDescription>
              From {selectedSubmission?.name} ({selectedSubmission?.email}) &middot;{' '}
              {selectedSubmission && new Date(selectedSubmission.created_at).toLocaleString()}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm whitespace-pre-wrap">{selectedSubmission?.message}</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <a
                  href={`mailto:${selectedSubmission?.email}?subject=Re: ${selectedSubmission?.subject}`}
                >
                  <Mail className="size-3.5 mr-1" />
                  Reply via Email
                </a>
              </Button>
              {selectedSubmission?.status !== 'replied' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (selectedSubmission) {
                      updateMutation.mutate({ id: selectedSubmission.id, status: 'replied' });
                      setSelectedSubmission({ ...selectedSubmission, status: 'replied' });
                    }
                  }}
                >
                  <Eye className="size-3.5 mr-1" />
                  Mark as Replied
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
