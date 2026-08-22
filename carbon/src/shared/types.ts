// Database types for Supabase
// These types are used by @supabase/supabase-js for type-safe queries

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          plan: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          plan?: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          plan?: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      memberships: {
        Row: {
          id: string;
          role: 'OWNER' | 'ADMIN' | 'MEMBER';
          user_id: string;
          organization_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          role?: 'OWNER' | 'ADMIN' | 'MEMBER';
          user_id: string;
          organization_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          role?: 'OWNER' | 'ADMIN' | 'MEMBER';
          user_id?: string;
          organization_id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memberships_organization_id_fkey';
            columns: ['organization_id'];
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      customers: {
        Row: {
          id: string;
          user_id: string | null;
          organization_id: string | null;
          stripe_customer_id: string;
          email: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          organization_id?: string | null;
          stripe_customer_id: string;
          email?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          organization_id?: string | null;
          stripe_customer_id?: string;
          email?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'customers_organization_id_fkey';
            columns: ['organization_id'];
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      subscriptions: {
        Row: {
          id: string;
          customer_id: string;
          stripe_subscription_id: string;
          stripe_price_id: string;
          status:
            | 'active'
            | 'canceled'
            | 'incomplete'
            | 'incomplete_expired'
            | 'past_due'
            | 'trialing'
            | 'unpaid'
            | 'paused';
          current_period_start: string | null;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          canceled_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          customer_id: string;
          stripe_subscription_id: string;
          stripe_price_id: string;
          status:
            | 'active'
            | 'canceled'
            | 'incomplete'
            | 'incomplete_expired'
            | 'past_due'
            | 'trialing'
            | 'unpaid'
            | 'paused';
          current_period_start?: string | null;
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          customer_id?: string;
          stripe_subscription_id?: string;
          stripe_price_id?: string;
          status?:
            | 'active'
            | 'canceled'
            | 'incomplete'
            | 'incomplete_expired'
            | 'past_due'
            | 'trialing'
            | 'unpaid'
            | 'paused';
          current_period_start?: string | null;
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'subscriptions_customer_id_fkey';
            columns: ['customer_id'];
            referencedRelation: 'customers';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications: {
        Row: {
          id: string;
          title: string;
          message: string | null;
          type: 'info' | 'warning' | 'error' | 'success';
          dismissible: boolean;
          organization_id: string | null;
          starts_at: string | null;
          ends_at: string | null;
          action_label: string | null;
          action_url: string | null;
          is_active: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          message?: string | null;
          type?: 'info' | 'warning' | 'error' | 'success';
          dismissible?: boolean;
          organization_id?: string | null;
          starts_at?: string | null;
          ends_at?: string | null;
          action_label?: string | null;
          action_url?: string | null;
          is_active?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          message?: string | null;
          type?: 'info' | 'warning' | 'error' | 'success';
          dismissible?: boolean;
          organization_id?: string | null;
          starts_at?: string | null;
          ends_at?: string | null;
          action_label?: string | null;
          action_url?: string | null;
          is_active?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_organization_id_fkey';
            columns: ['organization_id'];
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      notification_dismissals: {
        Row: {
          id: string;
          notification_id: string;
          user_id: string;
          dismissed_at: string;
        };
        Insert: {
          id?: string;
          notification_id: string;
          user_id: string;
          dismissed_at?: string;
        };
        Update: {
          id?: string;
          notification_id?: string;
          user_id?: string;
          dismissed_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_dismissals_notification_id_fkey';
            columns: ['notification_id'];
            referencedRelation: 'notifications';
            referencedColumns: ['id'];
          },
        ];
      };
      failed_login_attempts: {
        Row: {
          id: string;
          email: string;
          ip_address: string;
          attempted_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          ip_address: string;
          attempted_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          ip_address?: string;
          attempted_at?: string;
        };
        Relationships: [];
      };
      app_settings: {
        Row: {
          key: string;
          value: Json;
          updated_by: string | null;
          updated_at: string;
        };
        Insert: {
          key: string;
          value?: Json;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          key?: string;
          value?: Json;
          updated_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      cleanup_old_login_attempts: {
        Args: { p_retention_hours: number };
        Returns: undefined;
      };
    };
    Enums: {
      plan_type: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
      role_type: 'OWNER' | 'ADMIN' | 'MEMBER';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

// Helper types for common use
export type Organization = Database['public']['Tables']['organizations']['Row'];
export type Membership = Database['public']['Tables']['memberships']['Row'];
export type Customer = Database['public']['Tables']['customers']['Row'];
export type Subscription = Database['public']['Tables']['subscriptions']['Row'];
export type Notification = Database['public']['Tables']['notifications']['Row'];
export type NotificationDismissal = Database['public']['Tables']['notification_dismissals']['Row'];
export type FailedLoginAttempt = Database['public']['Tables']['failed_login_attempts']['Row'];
export type AppSetting = Database['public']['Tables']['app_settings']['Row'];
export type InsertOrganization = Database['public']['Tables']['organizations']['Insert'];
export type InsertMembership = Database['public']['Tables']['memberships']['Insert'];
