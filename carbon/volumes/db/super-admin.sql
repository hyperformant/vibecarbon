-- Create initial admin user in auth.users
-- This runs after Supabase GoTrue is initialized
-- Password hash is generated during project creation (plain password is never stored)

DO $$
DECLARE
  admin_email TEXT := '{{ADMIN_EMAIL}}';
  admin_password_hash TEXT := '{{ADMIN_PASSWORD_HASH}}';
  new_user_id UUID;
BEGIN
  -- Only create if admin email is provided and not empty
  -- Skip when the email is still an unreplaced "{{ADMIN_EMAIL}}" template token:
  -- the existence check could never match, so it would always attempt a
  -- duplicate INSERT and collide on UNIQUE(phone) with an existing admin.
  IF admin_email IS NOT NULL AND admin_email != '' AND admin_email NOT LIKE '{{%' THEN

    -- Check if user already exists
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = admin_email) THEN
      -- Generate a new UUID for the user
      new_user_id := gen_random_uuid();

      -- Create admin user with bcrypt-hashed password
      -- Note: GoTrue expects token columns to be empty strings, not NULL
      INSERT INTO auth.users (
        instance_id,
        id,
        aud,
        role,
        email,
        encrypted_password,
        email_confirmed_at,
        confirmation_sent_at,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at,
        confirmation_token,
        recovery_token,
        email_change_token_new,
        email_change_token_current,
        email_change,
        phone,
        phone_change,
        phone_change_token,
        reauthentication_token
      ) VALUES (
        '00000000-0000-0000-0000-000000000000',
        new_user_id,
        'authenticated',
        'authenticated',
        admin_email,
        admin_password_hash,
        NOW(),
        NOW(),
        jsonb_build_object(
          'provider', 'email',
          'providers', ARRAY['email'],
          'role', 'super_admin'
        ),
        '{"onboarding_completed": true}'::jsonb,
        NOW(),
        NOW(),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        ''
      );

      -- Create identity record for email provider
      INSERT INTO auth.identities (
        id,
        user_id,
        identity_data,
        provider,
        provider_id,
        last_sign_in_at,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        new_user_id,
        jsonb_build_object(
          'sub', new_user_id::text,
          'email', admin_email,
          'email_verified', true
        ),
        'email',
        new_user_id::text,
        NOW(),
        NOW(),
        NOW()
      );

      RAISE NOTICE 'Created admin user: % with id: %', admin_email, new_user_id;
    ELSE
      -- Update existing user to have super_admin role if they don't already
      UPDATE auth.users
      SET raw_app_meta_data = raw_app_meta_data || '{"role": "super_admin"}'::jsonb,
          updated_at = NOW()
      WHERE email = admin_email
        AND (raw_app_meta_data->>'role' IS NULL OR raw_app_meta_data->>'role' != 'super_admin');

      IF FOUND THEN
        RAISE NOTICE 'Updated existing user % to admin role', admin_email;
      ELSE
        RAISE NOTICE 'User % already exists with admin role', admin_email;
      END IF;
    END IF;
  ELSE
    RAISE NOTICE 'Skipping admin user creation - no admin email configured';
  END IF;
END $$;
