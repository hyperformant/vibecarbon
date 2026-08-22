import { HeaderActions } from '@/components/HeaderActions';

interface PageHeaderProps {
  title: string;
  description?: string;
}

export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header className="flex h-10 items-center justify-between pr-8 mt-6">
      <div className="flex items-center gap-3">
        <div className="relative">
          <h1 className="text-lg font-semibold leading-tight">{title}</h1>
          {description && (
            <p className="absolute top-full text-sm text-muted-foreground whitespace-nowrap">
              {description}
            </p>
          )}
        </div>
      </div>
      <HeaderActions />
    </header>
  );
}
