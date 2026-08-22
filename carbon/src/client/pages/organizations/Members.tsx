import {
  IconCrown as Crown,
  IconLoader2 as Loader2,
  IconDots as MoreHorizontal,
  IconShield as Shield,
  IconTrash as Trash2,
  IconUser as User,
  IconUserPlus as UserPlus,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useAuth } from '@/components/auth/AuthProvider';
import { PageHeader } from '@/components/PageHeader';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type Member,
  type MemberRole,
  useOrganizationMembers,
} from '@/hooks/useOrganizationMembers';
import { useOrganizations } from '@/hooks/useOrganizations';
import { ContentPanel } from '../../components/ContentPanel';

function getRoleIcon(role: MemberRole) {
  switch (role) {
    case 'OWNER':
      return <Crown className="size-3" />;
    case 'ADMIN':
      return <Shield className="size-3" />;
    default:
      return <User className="size-3" />;
  }
}

function getRoleBadgeVariant(role: MemberRole) {
  switch (role) {
    case 'OWNER':
      return 'default';
    case 'ADMIN':
      return 'secondary';
    default:
      return 'outline';
  }
}

function getUserInitials(member: Member) {
  if (!member.user) return '?';
  const name = member.user.name;
  if (name) {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return member.user.email?.[0]?.toUpperCase() || '?';
}

export default function Members() {
  const { orgId } = useParams<{ orgId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { organizations } = useOrganizations();
  const { members, isLoading, error, addMember, updateRole, removeMember } =
    useOrganizationMembers(orgId);

  const [isAddMemberOpen, setIsAddMemberOpen] = useState(false);
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<'ADMIN' | 'MEMBER'>('MEMBER');
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);

  const organization = organizations.find((org) => org.id === orgId);
  const currentUserMembership = members.find((m) => m.user?.id === user?.id);
  const isAdmin =
    currentUserMembership?.role === 'OWNER' || currentUserMembership?.role === 'ADMIN';
  const isOwner = currentUserMembership?.role === 'OWNER';

  const handleAddMember = async () => {
    if (!newMemberEmail.trim()) return;

    try {
      await addMember.mutateAsync({ email: newMemberEmail.trim(), role: newMemberRole });
      setNewMemberEmail('');
      setNewMemberRole('MEMBER');
      setIsAddMemberOpen(false);
    } catch {
      // Error is handled by mutation
    }
  };

  const handleUpdateRole = async (userId: string, role: MemberRole) => {
    try {
      await updateRole.mutateAsync({ userId, role });
    } catch {
      // Error is handled by mutation
    }
  };

  const handleRemoveMember = async () => {
    if (!memberToRemove?.user) return;

    try {
      await removeMember.mutateAsync(memberToRemove.user.id);
      setMemberToRemove(null);
    } catch {
      // Error is handled by mutation
    }
  };

  if (!organization) {
    return (
      <>
        <PageHeader title="Organization Not Found" />
        <ContentPanel variant="default">
          <p className="text-muted-foreground">
            The organization you're looking for doesn't exist or you don't have access.
          </p>
          <Button className="mt-4" onClick={() => navigate('/dashboard')}>
            Go to Dashboard
          </Button>
        </ContentPanel>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Organization Settings" />

      <ContentPanel variant="default">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Team Members</h2>
            <p className="text-muted-foreground">Manage who has access to {organization.name}</p>
          </div>
          {isAdmin && (
            <Button onClick={() => setIsAddMemberOpen(true)}>
              <UserPlus className="mr-2 size-4" />
              Add Member
            </Button>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Members ({members.length})</CardTitle>
            <CardDescription>People with access to this organization.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="py-8 text-center text-destructive">
                {error instanceof Error ? error.message : 'Failed to load members'}
              </div>
            ) : (
              <div className="space-y-3">
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-3">
                      <Avatar>
                        <AvatarFallback>{getUserInitials(member)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">
                          {member.user?.name || member.user?.email || 'Unknown'}
                          {member.user?.id === user?.id && (
                            <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                          )}
                        </p>
                        {member.user?.name && (
                          <p className="text-sm text-muted-foreground">{member.user.email}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={getRoleBadgeVariant(member.role)}>
                        <span className="mr-1">{getRoleIcon(member.role)}</span>
                        {member.role}
                      </Badge>
                      {isAdmin && member.user?.id !== user?.id && (
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {isOwner && member.role !== 'OWNER' && member.user && (
                              <>
                                <DropdownMenuItem
                                  onClick={() => handleUpdateRole(member.user?.id ?? '', 'OWNER')}
                                >
                                  <Crown className="mr-2 size-4" />
                                  Transfer Ownership
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                              </>
                            )}
                            {member.role === 'MEMBER' && member.user && (
                              <DropdownMenuItem
                                onClick={() => handleUpdateRole(member.user?.id ?? '', 'ADMIN')}
                              >
                                <Shield className="mr-2 size-4" />
                                Make Admin
                              </DropdownMenuItem>
                            )}
                            {member.role === 'ADMIN' && isOwner && member.user && (
                              <DropdownMenuItem
                                onClick={() => handleUpdateRole(member.user?.id ?? '', 'MEMBER')}
                              >
                                <User className="mr-2 size-4" />
                                Remove Admin
                              </DropdownMenuItem>
                            )}
                            {member.role !== 'OWNER' && (isOwner || member.role === 'MEMBER') && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setMemberToRemove(member)}
                                >
                                  <Trash2 className="mr-2 size-4" />
                                  Remove
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      {member.user?.id === user?.id && member.role !== 'OWNER' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setMemberToRemove(member)}
                        >
                          Leave
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </ContentPanel>

      {/* Add Member Dialog */}
      <Dialog open={isAddMemberOpen} onOpenChange={setIsAddMemberOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
            <DialogDescription>
              Invite someone to join this organization. They must already have an account.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                placeholder="colleague@example.com"
                value={newMemberEmail}
                onChange={(e) => setNewMemberEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !addMember.isPending) {
                    handleAddMember();
                  }
                }}
                disabled={addMember.isPending}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="role">Role</Label>
              <Select
                value={newMemberRole}
                onValueChange={(value) => {
                  if (value === 'ADMIN' || value === 'MEMBER') {
                    setNewMemberRole(value);
                  }
                }}
                disabled={addMember.isPending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">
                    <span className="flex items-center gap-2">
                      <User className="size-4" />
                      Member
                    </span>
                  </SelectItem>
                  <SelectItem value="ADMIN">
                    <span className="flex items-center gap-2">
                      <Shield className="size-4" />
                      Admin
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {addMember.error && (
              <p className="text-sm text-destructive">
                {addMember.error instanceof Error
                  ? addMember.error.message
                  : 'Failed to add member'}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsAddMemberOpen(false);
                setNewMemberEmail('');
                setNewMemberRole('MEMBER');
              }}
              disabled={addMember.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddMember}
              disabled={!newMemberEmail.trim() || addMember.isPending}
            >
              {addMember.isPending ? 'Adding...' : 'Add Member'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Member Dialog */}
      <Dialog open={!!memberToRemove} onOpenChange={() => setMemberToRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {memberToRemove?.user?.id === user?.id ? 'Leave Organization' : 'Remove Member'}
            </DialogTitle>
            <DialogDescription>
              {memberToRemove?.user?.id === user?.id
                ? 'Are you sure you want to leave this organization? You will lose access to all organization resources.'
                : `Are you sure you want to remove ${memberToRemove?.user?.name || memberToRemove?.user?.email} from this organization?`}
            </DialogDescription>
          </DialogHeader>
          {removeMember.error && (
            <p className="text-sm text-destructive">
              {removeMember.error instanceof Error
                ? removeMember.error.message
                : 'Failed to remove member'}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMemberToRemove(null)}
              disabled={removeMember.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemoveMember}
              disabled={removeMember.isPending}
            >
              {removeMember.isPending
                ? 'Removing...'
                : memberToRemove?.user?.id === user?.id
                  ? 'Leave'
                  : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
