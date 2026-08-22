import {
  IconAlertCircle as AlertCircle,
  IconChevronDown as ChevronDown,
  IconExternalLink as ExternalLink,
  IconLoader2 as Loader2,
  IconRefresh as RefreshCw,
  IconTerminal2 as Terminal,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { adminServices, getServiceUrl } from '@/lib/admin-services';
import { getAuthHeaders } from '@/lib/api';
import { cn } from '@/lib/utils';

interface LogsResponse {
  success: boolean;
  logs: string[];
  error?: string;
  meta?: {
    tail: number;
    since: string;
    container: string;
    lineCount: number;
    timestamp: string;
  };
}

interface ContainersResponse {
  containers: Array<{
    name: string;
    container: string;
  }>;
}

const TIME_OPTIONS = [
  { label: 'Last 5 minutes', value: '5m' },
  { label: 'Last 10 minutes', value: '10m' },
  { label: 'Last 30 minutes', value: '30m' },
  { label: 'Last 1 hour', value: '1h' },
  { label: 'Last 6 hours', value: '6h' },
  { label: 'Last 24 hours', value: '24h' },
];

const TAIL_OPTIONS = [
  { label: '100 lines', value: 100 },
  { label: '200 lines', value: 200 },
  { label: '500 lines', value: 500 },
  { label: '1000 lines', value: 1000 },
];

async function fetchLogs(container: string, since: string, tail: number): Promise<LogsResponse> {
  const params = new URLSearchParams({
    since,
    tail: String(tail),
  });
  if (container !== 'all') {
    params.set('container', container);
  }
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/_internal/services/status/logs?${params}`, { headers });
  return response.json();
}

async function fetchContainers(): Promise<ContainersResponse> {
  const headers = await getAuthHeaders();
  const response = await fetch('/api/_internal/services/status/logs/containers', { headers });
  return response.json();
}

// Color code log lines based on content
function getLogLineClass(line: string): string {
  const lowerLine = line.toLowerCase();
  if (lowerLine.includes('error') || lowerLine.includes('fatal') || lowerLine.includes('panic')) {
    return 'text-destructive';
  }
  if (lowerLine.includes('warn')) {
    return 'text-warning';
  }
  if (lowerLine.includes('debug') || lowerLine.includes('trace')) {
    return 'text-gray-500';
  }
  return '';
}

// Extract container name from log line (format: "container-name  | timestamp log...")
function parseLogLine(line: string): { container?: string; content: string } {
  const match = line.match(/^([a-z0-9_-]+)\s+\|\s+(.*)$/i);
  if (match) {
    return { container: match[1], content: match[2] };
  }
  return { content: line };
}

const projectName = import.meta.env.VITE_PROJECT_NAME ?? '{{PROJECT_NAME}}';

function getGrafanaLogsUrl(): string | null {
  const monitoring = adminServices.find((s) => s.id === 'monitoring');
  const base = monitoring ? getServiceUrl(monitoring) : null;
  return base && `${base}/d/${projectName}-logs/logs`;
}

interface DockerLogsProps {
  showGrafanaLink?: boolean;
}

export function DockerLogs({ showGrafanaLink = false }: DockerLogsProps) {
  const [selectedContainer, setSelectedContainer] = useState('all');
  const [since, setSince] = useState('10m');
  const [tail, setTail] = useState(200);
  const [autoScroll, setAutoScroll] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const { data: containersData } = useQuery({
    queryKey: ['docker-containers'],
    queryFn: fetchContainers,
  });

  const {
    data: logsData,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['docker-logs', selectedContainer, since, tail],
    queryFn: () => fetchLogs(selectedContainer, since, tail),
    refetchInterval: 10000, // Auto-refresh every 10 seconds
    staleTime: 5000,
  });

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logsEndRef.current && logsData?.logs) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logsData?.logs, autoScroll]);

  const containers = containersData?.containers || [];
  const logs = logsData?.logs || [];
  const selectedTimeOption = TIME_OPTIONS.find((o) => o.value === since);
  const selectedTailOption = TAIL_OPTIONS.find((o) => o.value === tail);
  const selectedContainerName =
    selectedContainer === 'all'
      ? 'All Containers'
      : containers.find((c) => c.container === selectedContainer)?.name || selectedContainer;

  const handleOpenGrafana = () => {
    const url = getGrafanaLogsUrl();
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      {/* Header with filters and actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Container filter */}
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-w-[140px]">
              {selectedContainerName}
              <ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => setSelectedContainer('all')}>
                All Containers
              </DropdownMenuItem>
              {containers.map((c) => (
                <DropdownMenuItem
                  key={c.container}
                  onClick={() => setSelectedContainer(c.container)}
                >
                  {c.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Time filter */}
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-w-[140px]">
              {selectedTimeOption?.label}
              <ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {TIME_OPTIONS.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => setSince(option.value)}>
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Tail filter */}
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-w-[120px]">
              {selectedTailOption?.label}
              <ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {TAIL_OPTIONS.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => setTail(option.value)}>
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Auto-scroll toggle */}
          <Button
            variant={autoScroll ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setAutoScroll(!autoScroll)}
          >
            Auto-scroll {autoScroll ? 'ON' : 'OFF'}
          </Button>

          {/* Refresh button */}
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
          </Button>
        </div>

        {/* Grafana link */}
        {showGrafanaLink && (
          <Button onClick={handleOpenGrafana} size="sm">
            <ExternalLink className="mr-2 size-4" />
            Open Grafana Logs
          </Button>
        )}
      </div>

      {/* Terminal section - fills remaining space */}
      {isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border bg-zinc-950">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : error || (logsData && !logsData.success) ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 rounded-lg border bg-zinc-950 text-center">
          <AlertCircle className="size-8 text-destructive" />
          <div>
            <p className="font-medium text-zinc-200">Failed to load logs</p>
            <p className="text-sm text-zinc-400">
              {logsData?.error || 'Could not connect to Docker'}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-2 size-4" />
            Retry
          </Button>
        </div>
      ) : logs.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border bg-zinc-950 text-center">
          <Terminal className="size-8 text-zinc-500" />
          <p className="text-zinc-400">No logs found for the selected filters</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto rounded-lg border bg-zinc-950 p-4 font-mono text-xs">
          <div>
            {logs.map((line, index) => {
              const { container, content } = parseLogLine(line);
              const lineKey = `${index}-${line.slice(0, 50)}`;
              return (
                <div key={lineKey} className={cn('whitespace-pre', getLogLineClass(line))}>
                  {container && <span className="mr-2 text-info">[{container}]</span>}
                  <span className="text-zinc-300">{content}</span>
                </div>
              );
            })}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </>
  );
}
