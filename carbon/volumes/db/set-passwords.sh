#!/bin/bash
set -e

# Mounted at /docker-entrypoint-initdb.d/zz-set-passwords.sh (top level), so the
# postgres entrypoint runs it after migrate.sh. No role left in the stack logs
# in with a password of its own: the app connects as the database owner, and
# the image entrypoint sets that password from POSTGRES_PASSWORD. Nothing to do.
