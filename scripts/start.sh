#!/bin/sh

echo "Starting Zycloud core..."
echo "Syncing database schema (PostgreSQL)..."

yarn prisma db push

echo "Starting server..."
node src/index.js
