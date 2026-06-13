#!/usr/bin/env bash
# Run after: wrangler login + verified Cloudflare email
set -euo pipefail

echo "→ Applying remote D1 schema..."
npx wrangler d1 execute harness-db --remote --file=schema.sql

echo "→ Setting GITHUB_TOKEN secret (paste token when prompted)..."
npx wrangler secret put GITHUB_TOKEN

echo "→ Deploying Worker..."
npx wrangler deploy

echo "✓ Done. Your app URL is shown above (workers.dev)."
