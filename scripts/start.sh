#!/bin/sh

echo "Starting Zycloud core..."
echo "Syncing database schema (provider: ${DATABASE_PROVIDER})..."

if [ "$DATABASE_PROVIDER" = "sqlite" ]; then
  yarn prisma db push --schema=prisma/schema.dev.prisma
else
  yarn prisma db push
fi

echo "Starting server..."
node src/index.js
