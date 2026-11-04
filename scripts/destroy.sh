#!/usr/bin/env bash
# One-command teardown: deletes every resource, including buckets with files and ECR images.
set -euo pipefail
cd "$(dirname "$0")/../infra"

if [ "${1:-}" != "-y" ]; then
  read -r -p "This deletes the whole Sharebox stack and every stored file. Type 'destroy' to continue: " ans
  [ "$ans" = "destroy" ] || { echo "Cancelled."; exit 1; }
fi

[ -d ../lambdas/dist ] || (cd .. && npm ci --no-audit --no-fund && npm run build:lambdas)
terraform init -input=false >/dev/null
terraform destroy -input=false -auto-approve
echo "All resources deleted. Check the Billing console tomorrow to confirm \$0 daily spend."
