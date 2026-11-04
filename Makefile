.PHONY: install test dev lambdas docker docker-run deploy destroy plan outputs fmt

install:        ## Install all workspace dependencies
	npm ci

test:           ## Run unit tests (core, app, lambdas)
	npm test

dev:            ## Run the whole app locally on http://localhost:8080 (no AWS needed)
	npm run dev

lambdas:        ## Bundle Lambdas into lambdas/dist
	npm run build:lambdas

docker:         ## Build the API image
	docker build -f app/Dockerfile -t sharebox-api .

docker-run: docker  ## Run the image locally in dev mode
	docker compose up

plan: lambdas   ## Terraform plan
	cd infra && terraform init -input=false && terraform plan

deploy:         ## Create everything in AWS and ship the first version
	./scripts/deploy.sh

destroy:        ## Delete everything in AWS
	./scripts/destroy.sh

outputs:
	cd infra && terraform output

fmt:
	cd infra && terraform fmt -recursive
