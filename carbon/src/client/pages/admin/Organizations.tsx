import {
  IconBuilding as Building2,
  IconLoader2 as Loader2,
  IconSearch as Search,
  IconUsers as Users,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { ListPagination, SortableHead } from '@/components/admin/list-controls';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { type SortOrder, useListControls } from '@/hooks/useListControls';
import { apiJson } from '@/lib/api';
import { ContentPanel } from '../../components/ContentPanel';

type Organization = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

type SortField = 'name' | 'slug' | 'plan' | 'created_at';

async function fetchOrganizations(params: {
  search: string;
  sortBy: SortField;
  sortOrder: SortOrder;
  page: number;
  limit: number;
}): Promise<{ organizations: Organization[]; pagination: { total: number; totalPages: number } }> {
  const queryParams = new URLSearchParams({
    search: params.search,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
    page: params.page.toString(),
    limit: params.limit.toString(),
  });

  return apiJson<{
    organizations: Organization[];
    pagination: { total: number; totalPages: number };
  }>(`/api/v1/admin/organizations?${queryParams}`, {}, 'Failed to fetch organizations');
}

function getPlanBadgeVariant(plan: string) {
  switch (plan) {
    case 'ENTERPRISE':
      return 'default';
    case 'PRO':
      return 'secondary';
    case 'STARTER':
      return 'outline';
    default:
      return 'outline';
  }
}

export default function AdminOrganizations() {
  const {
    search,
    sortBy,
    sortOrder,
    sortValue,
    page,
    setPage,
    toggleSort,
    handleSearch,
    selectSort,
  } = useListControls<SortField>('created_at');
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-organizations', search, sortBy, sortOrder, page],
    queryFn: () => fetchOrganizations({ search, sortBy, sortOrder, page, limit }),
  });

  const organizations = data?.organizations || [];
  const totalPages = data?.pagination.totalPages || 1;
  const total = data?.pagination.total || 0;

  const sortOptions: Record<string, string> = {
    'created_at-desc': 'Newest first',
    'created_at-asc': 'Oldest first',
    'name-asc': 'Name A-Z',
    'name-desc': 'Name Z-A',
  };

  return (
    <>
      <PageHeader title="Organizations" description="Manage organizations" />

      <ContentPanel variant="full">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Organizations ({total})</CardTitle>
                <CardDescription>
                  A list of all organizations registered in the system.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or slug..."
                    value={search}
                    onChange={(e) => handleSearch(e.target.value)}
                    className="pl-8 w-64"
                  />
                </div>
                <Select defaultValue="created_at-desc" value={sortValue} onValueChange={selectSort}>
                  <SelectTrigger className="w-44">
                    <span>{sortOptions[sortValue]}</span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="created_at-desc">Newest first</SelectItem>
                    <SelectItem value="created_at-asc">Oldest first</SelectItem>
                    <SelectItem value="name-asc">Name A-Z</SelectItem>
                    <SelectItem value="name-desc">Name Z-A</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="py-8 text-center text-destructive">
                {error instanceof Error ? error.message : 'Failed to load organizations'}
              </div>
            ) : organizations.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                {search ? 'No organizations match your search.' : 'No organizations found.'}
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableHead onClick={() => toggleSort('name')}>Organization</SortableHead>
                      <SortableHead onClick={() => toggleSort('slug')}>Slug</SortableHead>
                      <SortableHead onClick={() => toggleSort('plan')}>Plan</SortableHead>
                      <TableHead>Members</TableHead>
                      <SortableHead onClick={() => toggleSort('created_at')}>Created</SortableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {organizations.map((org) => (
                      <TableRow key={org.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Building2 className="size-4 text-muted-foreground" />
                            <span className="font-medium">{org.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <code className="text-sm text-muted-foreground">{org.slug}</code>
                        </TableCell>
                        <TableCell>
                          <Badge variant={getPlanBadgeVariant(org.plan)}>{org.plan}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Users className="size-4 text-muted-foreground" />
                            <span>{org.memberCount}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(org.createdAt).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                <ListPagination page={page} totalPages={totalPages} onPage={setPage} />
              </>
            )}
          </CardContent>
        </Card>
      </ContentPanel>
    </>
  );
}
