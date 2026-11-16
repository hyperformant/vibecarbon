import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useHostMaintenance } from '@/hooks/api';

/**
 * Super-admin banner: security updates are installed but a server needs a
 * restart, and/or a server has not started reporting. A read error says the
 * servers could not be checked. Renders nothing while loading, with no
 * runtime, or when everything is current.
 */
export function HostMaintenanceNotice() {
  const { t } = useTranslation();
  const { data, isError } = useHostMaintenance();

  // A failed read must not look like "nothing due".
  if (isError) {
    return (
      <p className="p-4 pb-0 text-sm text-muted-foreground">
        {t('admin.hostMaintenance.unavailable')}
      </p>
    );
  }

  if (!data || data.runtime === 'none') return null;

  const due = data.servers.filter((s) => s.rebootRequired);
  const silent = data.servers.filter((s) => !s.reporting);
  if (due.length === 0 && silent.length === 0) return null;

  const command = `vibecarbon update ${data.envName ?? '<your environment>'}`;

  return (
    <div className="flex flex-col gap-3 p-4 pb-0">
      {due.length > 0 && (
        <Alert>
          <IconAlertTriangle />
          <AlertTitle>{t('admin.hostMaintenance.title')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <p>
              {t('admin.hostMaintenance.body', {
                servers: due.map((s) => s.name).join(', '),
                command,
              })}
            </p>
            <Link to="/docs/cli#update" className="underline">
              {t('admin.hostMaintenance.docsLink')}
            </Link>
            <Collapsible>
              <CollapsibleTrigger className="underline">
                {t('admin.hostMaintenance.showPackages')}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-1 flex flex-col gap-1">
                  {due.map((s) => (
                    <li key={s.name}>
                      {s.name}: {s.packages.join(', ')}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </AlertDescription>
        </Alert>
      )}
      {silent.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t('admin.hostMaintenance.notReporting', {
            servers: silent.map((s) => s.name).join(', '),
            command,
          })}
        </p>
      )}
    </div>
  );
}
