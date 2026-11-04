#!/usr/bin/env bash
# One-command deploy: builds everything, creates the infrastructure and ships the first version.
set -euo pipefail
cd "$(dirname "$0")/.."

for bin in aws terraform docker node npm; do
  command -v "$bin" >/dev/null || { echo "Missing '$bin'. See README > Prerequisites."; exit 1; }
done
aws sts get-caller-identity >/dev/null || { echo "AWS credentials not configured (run 'aws configure')."; exit 1; }

echo "==> Installing dependencies and running tests"
npm ci --no-audit --no-fund
npm test

echo "==> Bundling Lambdas"
npm run build:lambdas

cd infra
[ -f terraform.tfvars ] || { cp terraform.tfvars.example terraform.tfvars; echo "Created infra/terraform.tfvars from the example. Edit alert_email, then re-run."; exit 1; }
terraform init -input=false

echo "==> Creating the ECR repository first (instances need an image to pull)"
terraform apply -input=false -auto-approve -target=aws_ecr_repository.app -target=aws_ecr_lifecycle_policy.app
REPO=$(terraform output -raw ecr_repository_url 2>/dev/null || terraform state show -no-color aws_ecr_repository.app | awk -F'"' '/repository_url/ {print $2}')
REGION=$(terraform console <<< 'var.region' | tr -d '"')
cd ..

echo "==> Building and pushing the API image to $REPO"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REPO%%/*}"
TAG=$(git rev-parse --short HEAD 2>/dev/null || date +%s)
docker build --platform linux/amd64 -f app/Dockerfile --build-arg APP_VERSION="$TAG" -t "$REPO:$TAG" -t "$REPO:latest" .
docker push "$REPO:$TAG"
docker push "$REPO:latest"

echo "==> Applying the full stack (about 10 minutes, CloudFront is the slow part)"
cd infra
terraform apply -input=false -auto-approve

echo
echo "Done. Open: $(terraform output -raw app_url)"
echo "Instances take ~3 minutes to boot and pass health checks. Dashboard: $(terraform output -raw dashboard_url)"
