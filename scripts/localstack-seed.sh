#!/usr/bin/env bash
# Seed LocalStack with a known set of resources for the Scope 3 cost-engine harness (ADR 0003 D4).
# Runs `awslocal` inside the LocalStack container, so no host AWS CLI is needed.
#
# Fixture:
#   sa-east-1     unattached gp3 volume, 500 GiB          -> priced (gp3 rate)
#   sa-east-1     unassociated Elastic IP                 -> priced (flat hourly x 730)
#   sa-east-1     orphan snapshot of a deleted 200 GiB volume -> priced (snapshot rate)
#   ca-central-1  unattached gp3 volume, 100 GiB          -> region NOT in the table -> "unpriced"
#
# Usage:  docker compose -f docker-compose.localstack.yml up -d && bash scripts/localstack-seed.sh

set -euo pipefail

COMPOSE_FILE="$(dirname "$0")/../docker-compose.localstack.yml"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
awslocal() { dc exec -T localstack awslocal "$@"; }

echo "waiting for LocalStack to be ready..."
for _ in $(seq 1 30); do
  if dc exec -T localstack curl -sf http://localhost:4566/_localstack/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "seeding sa-east-1 (covered region)..."
awslocal --region sa-east-1 ec2 create-volume \
  --availability-zone sa-east-1a --size 500 --volume-type gp3 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=ct-idle-gp3}]' >/dev/null

awslocal --region sa-east-1 ec2 allocate-address --domain vpc >/dev/null

VOL=$(awslocal --region sa-east-1 ec2 create-volume \
  --availability-zone sa-east-1a --size 200 --volume-type gp2 \
  --query VolumeId --output text)
awslocal --region sa-east-1 ec2 create-snapshot --volume-id "$VOL" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=ct-orphan-snap}]' >/dev/null
awslocal --region sa-east-1 ec2 delete-volume --volume-id "$VOL"  # orphans the snapshot

echo "seeding ca-central-1 (region NOT in the price table)..."
awslocal --region ca-central-1 ec2 create-volume \
  --availability-zone ca-central-1a --size 100 --volume-type gp3 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=ct-unpriced}]' >/dev/null

echo "done. run the harness with:"
echo "  ( cd src-tauri && AWS_ENDPOINT_URL=http://localhost:4566 cargo test --test localstack -- --ignored --nocapture )"
