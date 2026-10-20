#!/bin/sh
# Persistent disks (Docker volume, Render disk) may be mounted owned by root: prepare the upload
# folder as root, then run the application as the unprivileged "node" user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${UPLOAD_DIR:-/data/uploads}"
  chown -R node:node "${UPLOAD_DIR:-/data/uploads}"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
