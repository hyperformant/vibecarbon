import {
  IconDownload as Download,
  IconLoader2 as Loader2,
  IconMail as Mail,
  IconSearch as Search,
  IconSend as Send,
  IconTrash as Trash2,
  IconUsers as Users,
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, apiJson } from '@/lib/api';
import { ContentPanel } from '../../components/ContentPanel';

interface Subscriber {
  id: string;
  email: string;
  name: string | null;
  status: string;
  subscribed_at: string | null;
  created_at: string;
}

interface Stats {
  total: number;
  active: number;
  pending: number;
  unsubscribed: number;
}

const subscribersKey = ['admin', 'newsletter-subscribers'];
const statsKey = ['admin', 'newsletter-stats'];

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
    active: 'default',
    pending: 'secondary',
    unsubscribed: 'outline',
  };
  return <Badge variant={variants[status] || 'outline'}>{status}</Badge>;
}

export default function AdminNewsletter() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');

  const { data: stats } = useQuery<Stats>({
    queryKey: statsKey,
    queryFn: () => apiJson<Stats>('/api/v1/admin/newsletter/stats', {}, 'Failed to fetch stats'),
  });

  const { data, isLoading } = useQuery<{ subscribers: Subscriber[]; total: number }>({
    queryKey: [...subscribersKey, search],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '50' });
      if (search) params.set('search', search);
      return apiJson<{ subscribers: Subscriber[]; total: number }>(
        `/api/v1/admin/newsletter?${params}`,
        {},
        'Failed to fetch subscribers'
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiJson<void>(`/api/v1/admin/newsletter/${id}`, { method: 'DELETE' }, 'Failed to delete'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: subscribersKey });
      queryClient.invalidateQueries({ queryKey: statsKey });
      toast.success('Subscriber removed');
    },
  });

  const sendMutation = useMutation({
    mutationFn: () =>
      apiJson<{ sent: number; failed: number }>(
        '/api/v1/admin/newsletter/send',
        {
          method: 'POST',
          body: {
            subject: composeSubject,
            html: composeBody.replace(/\n/g, '<br>'),
          },
        },
        'Failed to send'
      ),
    onSuccess: (data: { sent: number; failed: number }) => {
      setComposeOpen(false);
      setComposeSubject('');
      setComposeBody('');
      toast.success(`Newsletter sent to ${data.sent} subscribers`);
      if (data.failed > 0) {
        toast.error(`${data.failed} emails failed to send`);
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const handleExport = async () => {
    const response = await apiFetch('/api/v1/admin/newsletter/export');
    if (!response.ok) {
      toast.error('Failed to export');
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'newsletter-subscribers.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const subscribers = data?.subscribers ?? [];

  return (
    <>
      <PageHeader title="Newsletter" description="Manage subscribers and send newsletters" />

      <ContentPanel variant="default">
        <div className="space-y-6">
          {/* Stats */}
          {stats && (
            <div className="grid gap-4 sm:grid-cols-4">
              {[
                { label: 'Total', value: stats.total },
                { label: 'Active', value: stats.active },
                { label: 'Pending', value: stats.pending },
                { label: 'Unsubscribed', value: stats.unsubscribed },
              ].map((stat) => (
                <Card key={stat.label}>
                  <CardContent className="pt-4 pb-4">
                    <div className="text-2xl font-bold">{stat.value}</div>
                    <div className="text-xs text-muted-foreground">{stat.label}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button onClick={() => setComposeOpen(true)} disabled={!stats?.active}>
              <Send className="size-4 mr-2" />
              Compose Newsletter
            </Button>
            <Button variant="outline" onClick={handleExport}>
              <Download className="size-4 mr-2" />
              Export CSV
            </Button>
          </div>

          {/* Subscribers */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="size-5" />
                Subscribers
              </CardTitle>
              <CardDescription>{data?.total ?? 0} total subscribers</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4 relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  placeholder="Search by email or name..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>

              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              ) : subscribers.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No subscribers yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {subscribers.map((sub) => (
                    <div
                      key={sub.id}
                      className="flex items-center justify-between rounded-md border px-3 py-2"
                    >
                      <div className="flex items-center gap-3">
                        <Mail className="size-4 text-muted-foreground" />
                        <div>
                          <div className="text-sm font-medium">{sub.email}</div>
                          {sub.name && (
                            <div className="text-xs text-muted-foreground">{sub.name}</div>
                          )}
                        </div>
                        <StatusBadge status={sub.status} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {new Date(sub.created_at).toLocaleDateString()}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => deleteMutation.mutate(sub.id)}
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
        </div>
      </ContentPanel>

      {/* Compose dialog */}
      <Dialog open={composeOpen} onOpenChange={setComposeOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Compose Newsletter</DialogTitle>
            <DialogDescription>
              This will be sent to {stats?.active ?? 0} active subscribers. Each email includes an
              unsubscribe link.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Subject</Label>
              <Input
                value={composeSubject}
                onChange={(e) => setComposeSubject(e.target.value)}
                placeholder="Newsletter subject..."
              />
            </div>
            <div className="space-y-2">
              <Label>Content</Label>
              <Textarea
                value={composeBody}
                onChange={(e) => setComposeBody(e.target.value)}
                placeholder="Write your newsletter content here..."
                rows={10}
              />
              <p className="text-xs text-muted-foreground">
                Plain text. Line breaks will be converted to HTML.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setComposeOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => sendMutation.mutate()}
              disabled={!composeSubject || !composeBody || sendMutation.isPending}
            >
              {sendMutation.isPending ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Send className="size-4 mr-2" />
              )}
              Send to {stats?.active ?? 0} Subscribers
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
