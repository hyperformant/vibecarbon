import { IconEye as Eye, IconX as X } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth/AuthProvider';
import { Button } from './ui/button';

export function ImpersonationBanner() {
  const { t } = useTranslation();
  const { isImpersonating, impersonationTarget, stopImpersonating } = useAuth();

  if (!isImpersonating || !impersonationTarget) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[100] bg-amber-500 text-black px-4 py-1.5 flex items-center justify-center gap-3 text-sm font-medium">
      <Eye className="size-4 shrink-0" />
      <span>
        {t('admin.impersonating', {
          email: impersonationTarget.email,
        })}
      </span>
      <Button
        variant="ghost"
        size="xs"
        className="h-6 px-2 text-black hover:bg-amber-600 hover:text-black"
        onClick={stopImpersonating}
      >
        <X className="size-3 mr-1" />
        {t('admin.stopImpersonating')}
      </Button>
    </div>
  );
}
