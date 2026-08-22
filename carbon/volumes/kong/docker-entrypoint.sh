#!/bin/sh
# Substitute environment variables in Kong config template
sed \
  -e "s|\\\$SUPABASE_ANON_KEY|${SUPABASE_ANON_KEY}|g" \
  -e "s|\\\$SUPABASE_SERVICE_ROLE_KEY|${SUPABASE_SERVICE_ROLE_KEY}|g" \
  /home/kong/kong.yml.template > /tmp/kong.yml

# Start Kong normally
exec /docker-entrypoint.sh kong docker-start
