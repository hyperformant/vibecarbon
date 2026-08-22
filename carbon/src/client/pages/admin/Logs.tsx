import { DockerLogs } from '@/components/admin/DockerLogs';
import { PageHeader } from '@/components/PageHeader';
import { useEnabledServices } from '@/hooks/useRunningServices';

export default function AdminLogs() {
  const { services } = useEnabledServices();
  const observabilityEnabled = services.some((s) => s.id === 'monitoring');

  return (
    <>
      <PageHeader title="Logs" description="Application and audit logs" />

      <div className="flex flex-1 flex-col gap-4 overflow-hidden p-6">
        <DockerLogs showGrafanaLink={observabilityEnabled} />
      </div>
    </>
  );
}
