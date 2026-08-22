import {
  IconArrowsUpDown as ArrowUpDown,
  IconBuilding as Building2,
  IconChevronLeft as ChevronLeft,
  IconChevronRight as ChevronRight,
  IconLoader2 as Loader2,
  IconSearch as Search,
  IconUsers as Users,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
type SortOrder = 'asc' | 'desc';

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
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('created_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-organizations', search, sortBy, sortOrder, page],
    queryFn: () => fetchOrganizations({ search, sortBy, sortOrder, page, limit }),
  });

  const organizations = data?.organizations || [];
  const totalPages = data?.pagination.totalPages || 1;
  const total = data?.pagination.total || 0;

  const toggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
    setPage(1);
  };

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const sortOptions: Record<string, string> = {
    'created_at-desc': 'Newest first',
    'created_at-asc': 'Oldest first',
    'name-asc': 'Name A-Z',
    'name-desc': 'Name Z-A',
  };
  const sortValue = `${sortBy}-${sortOrder}`;

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
                <Select
                  defaultValue="created_at-desc"
                  value={`${sortBy}-${sortOrder}`}
                  onValueChange={(value) => {
                    if (!value) return;
                    const [field, order] = value.split('-') as [SortField, SortOrder];
                    setSortBy(field);
                    setSortOrder(order);
                    setPage(1);
                  }}
                >
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
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-3 h-8"
                          onClick={() => toggleSort('name')}
                        >
                          Organization
                          <ArrowUpDown className="ml-2 size-4" />
                        </Button>
                      </TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-3 h-8"
                          onClick={() => toggleSort('slug')}
                        >
                          Slug
                          <ArrowUpDown className="ml-2 size-4" />
                        </Button>
                      </TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-3 h-8"
                          onClick={() => toggleSort('plan')}
                        >
                          Plan
                          <ArrowUpDown className="ml-2 size-4" />
                        </Button>
                      </TableHead>
                      <TableHead>Members</TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-3 h-8"
                          onClick={() => toggleSort('created_at')}
                        >
                          Created
                          <ArrowUpDown className="ml-2 size-4" />
                        </Button>
                      </TableHead>
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

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4 pt-4 border-t">
                    <p className="text-sm text-muted-foreground">
                      Page {page} of {totalPages}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(page - 1)}
                        disabled={page === 1}
                      >
                        <ChevronLeft className="size-4 mr-1" />
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(page + 1)}
                        disabled={page === totalPages}
                      >
                        Next
                        <ChevronRight className="size-4 ml-1" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </ContentPanel>
    </>
  );
}
