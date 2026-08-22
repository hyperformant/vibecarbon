import {
  IconArrowsUpDown as ArrowUpDown,
  IconBuilding as Building2,
  IconCircleCheck as CheckCircle,
  IconChevronLeft as ChevronLeft,
  IconChevronRight as ChevronRight,
  IconLoader2 as Loader2,
  IconLogin as LogIn,
  IconSearch as Search,
  IconShield as Shield,
  IconCircleX as XCircle,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useAuth } from '@/components/auth/AuthProvider';
import { PageHeader } from '@/components/PageHeader';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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

type User = {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  role: string | null;
  emailVerified: boolean;
  organizationCount: number;
  lastSignIn: string | null;
  createdAt: string;
};

type SortField = 'email' | 'name' | 'created_at';
type SortOrder = 'asc' | 'desc';

async function fetchUsers(params: {
  search: string;
  sortBy: SortField;
  sortOrder: SortOrder;
  page: number;
  limit: number;
}): Promise<{ users: User[]; pagination: { total: number; totalPages: number } }> {
  const queryParams = new URLSearchParams({
    search: params.search,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
    page: params.page.toString(),
    limit: params.limit.toString(),
  });

  return apiJson<{ users: User[]; pagination: { total: number; totalPages: number } }>(
    `/api/v1/admin/users?${queryParams}`,
    {},
    'Failed to fetch users'
  );
}

function getUserInitials(user: User) {
  if (user.name) {
    return user.name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return user.email?.[0]?.toUpperCase() || '?';
}

export default function AdminUsers() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { impersonateUser, user: currentUser } = useAuth();
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('created_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [page, setPage] = useState(1);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const limit = 20;

  const handleImpersonate = async (userId: string) => {
    setImpersonating(userId);
    try {
      await impersonateUser(userId);
      navigate('/dashboard');
    } catch {
      setImpersonating(null);
    }
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-users', search, sortBy, sortOrder, page],
    queryFn: () => fetchUsers({ search, sortBy, sortOrder, page, limit }),
  });

  const users = data?.users || [];
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
    'email-asc': 'Email A-Z',
    'email-desc': 'Email Z-A',
    'name-asc': 'Name A-Z',
    'name-desc': 'Name Z-A',
  };
  const sortValue = `${sortBy}-${sortOrder}`;

  return (
    <>
      <PageHeader title="Users" description="Manage user accounts" />

      <ContentPanel variant="full">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Users ({total})</CardTitle>
                <CardDescription>A list of all registered users in the system.</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or email..."
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
                    <SelectItem value="email-asc">Email A-Z</SelectItem>
                    <SelectItem value="email-desc">Email Z-A</SelectItem>
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
                {error instanceof Error ? error.message : 'Failed to load users'}
              </div>
            ) : users.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                {search ? 'No users match your search.' : 'No users found.'}
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
                          User
                          <ArrowUpDown className="ml-2 size-4" />
                        </Button>
                      </TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-3 h-8"
                          onClick={() => toggleSort('email')}
                        >
                          Email
                          <ArrowUpDown className="ml-2 size-4" />
                        </Button>
                      </TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Verified</TableHead>
                      <TableHead>Organizations</TableHead>
                      <TableHead>Last Sign In</TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-3 h-8"
                          onClick={() => toggleSort('created_at')}
                        >
                          Joined
                          <ArrowUpDown className="ml-2 size-4" />
                        </Button>
                      </TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Avatar className="size-8">
                              <AvatarFallback className="text-xs">
                                {getUserInitials(user)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="font-medium">
                              {user.name || <span className="text-muted-foreground">-</span>}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{user.email}</span>
                        </TableCell>
                        <TableCell>
                          {user.role === 'super_admin' ? (
                            <Badge variant="default">
                              <Shield className="size-3 mr-1" />
                              Super Admin
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {user.emailVerified ? (
                            <CheckCircle className="size-4 text-success" />
                          ) : (
                            <XCircle className="size-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Building2 className="size-4 text-muted-foreground" />
                            <span>{user.organizationCount}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {user.lastSignIn
                            ? new Date(user.lastSignIn).toLocaleDateString()
                            : 'Never'}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          {user.id !== currentUser?.id && user.role !== 'super_admin' && (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => handleImpersonate(user.id)}
                              disabled={impersonating === user.id}
                              title={t('admin.loginAsUser')}
                            >
                              {impersonating === user.id ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <LogIn className="size-3.5" />
                              )}
                            </Button>
                          )}
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
