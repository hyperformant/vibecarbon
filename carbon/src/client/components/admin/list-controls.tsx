// Table controls shared by the admin list pages (organizations, users): a
// sortable column header and Previous/Next pagination. Built from Shadcn's
// Table and Button; Shadcn's own Pagination is a link list, not a pager.
import {
  IconArrowsUpDown as ArrowUpDown,
  IconChevronLeft as ChevronLeft,
  IconChevronRight as ChevronRight,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { TableHead } from '@/components/ui/table';

interface SortableHeadProps {
  onClick: () => void;
  children: ReactNode;
}

export function SortableHead({ onClick, children }: SortableHeadProps) {
  return (
    <TableHead>
      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={onClick}>
        {children}
        <ArrowUpDown className="ml-2 size-4" />
      </Button>
    </TableHead>
  );
}

interface ListPaginationProps {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}

/** Renders nothing when everything fits on one page. */
export function ListPagination({ page, totalPages, onPage }: ListPaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between mt-4 pt-4 border-t">
      <p className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onPage(page - 1)} disabled={page === 1}>
          <ChevronLeft className="size-4 mr-1" />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPage(page + 1)}
          disabled={page === totalPages}
        >
          Next
          <ChevronRight className="size-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
