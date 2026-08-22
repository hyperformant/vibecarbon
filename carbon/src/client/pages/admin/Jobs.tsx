import {
  IconCircleCheck as CheckCircle,
  IconClock as Clock,
  IconLoader2 as Loader2,
  IconPlayerPlay as Play,
  IconCircleX as XCircle,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiJson } from '@/lib/api';
import { ContentPanel } from '../../components/ContentPanel';

interface JobSummary {
  name: string;
  lastRun: string | null;
  lastStatus: string;
  lastResult: string | null;
  lastError: string | null;
  runCount: number;
}

interface JobHistory {
  id: string;
  job_name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result: string | null;
  error: string | null;
}

const jobsQueryKey = ['admin', 'jobs'];

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'succeeded') {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle className="size-3" />
        Success
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="size-3" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <Clock className="size-3" />
      {status}
    </Badge>
  );
}

export default function AdminJobs() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ jobs: JobSummary[]; history: JobHistory[] }>({
    queryKey: jobsQueryKey,
    queryFn: () =>
      apiJson<{ jobs: JobSummary[]; history: JobHistory[] }>(
        '/api/v1/admin/jobs',
        {},
        'Failed to fetch jobs'
      ),
  });

  const { data: historyData } = useQuery<{ history: JobHistory[] }>({
    queryKey: [...jobsQueryKey, 'history'],
    queryFn: () =>
      apiJson<{ history: JobHistory[] }>(
        '/api/v1/admin/jobs/history?limit=50',
        {},
        'Failed to fetch job history'
      ),
  });

  const triggerMutation = useMutation({
    mutationFn: (jobName: string) =>
      apiJson<void>(
        '/api/v1/admin/jobs/trigger',
        { method: 'POST', body: { jobName } },
        'Failed to trigger job'
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: jobsQueryKey });
      toast.success('Job triggered successfully');
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const jobs = data?.jobs ?? [];
  const history = historyData?.history ?? data?.history ?? [];

  return (
    <>
      <PageHeader
        title="Background Jobs"
        description="Scheduled database jobs powered by pg_cron"
      />

      <ContentPanel variant="default">
        <div className="space-y-6">
          {/* Scheduled Jobs */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="size-5" />
                Scheduled Jobs
              </CardTitle>
              <CardDescription>
                Jobs are managed via pg_cron in PostgreSQL. Edit the migration file to add or modify
                schedules.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              ) : jobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No job history yet. Jobs will appear here after their first execution.
                </p>
              ) : (
                <div className="space-y-3">
                  {jobs.map((job) => (
                    <div
                      key={job.name}
                      className="flex items-center justify-between rounded-lg border p-4"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium font-mono text-sm">{job.name}</span>
                          <StatusBadge status={job.lastStatus} />
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {job.lastRun ? `Last run: ${formatDate(job.lastRun)}` : 'Never run'}
                          {job.runCount > 0 && ` (${job.runCount} total runs)`}
                        </div>
                        {job.lastResult && (
                          <p className="text-xs text-muted-foreground">{job.lastResult}</p>
                        )}
                        {job.lastError && (
                          <p className="text-xs text-destructive">{job.lastError}</p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => triggerMutation.mutate(job.name)}
                        disabled={triggerMutation.isPending}
                      >
                        {triggerMutation.isPending && triggerMutation.variables === job.name ? (
                          <Loader2 className="size-4 mr-1 animate-spin" />
                        ) : (
                          <Play className="size-4 mr-1" />
                        )}
                        Run Now
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Execution History */}
          <Card>
            <CardHeader>
              <CardTitle>Execution History</CardTitle>
              <CardDescription>Recent job executions (last 50)</CardDescription>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No execution history yet.</p>
              ) : (
                <div className="space-y-2">
                  {history.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                    >
                      <div className="flex items-center gap-3">
                        <StatusBadge status={entry.status} />
                        <span className="font-mono text-xs">{entry.job_name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-muted-foreground text-xs">
                        {entry.result && <span className="max-w-48 truncate">{entry.result}</span>}
                        {entry.error && (
                          <span className="max-w-48 truncate text-destructive">{entry.error}</span>
                        )}
                        <span>{formatDate(entry.started_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </ContentPanel>
    </>
  );
}
