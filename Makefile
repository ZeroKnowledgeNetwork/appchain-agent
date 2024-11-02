docker_image ?= zkn/agent:latest

.PHONY: image
image:
	docker build \
		--build-context context-appchain=../appchain \
		--file Dockerfile \
		--tag $(docker_image) \
		.
