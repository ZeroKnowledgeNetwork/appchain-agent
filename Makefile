docker_image ?= zkn/agent:latest

.PHONY: image
image:
	docker build \
		--build-context context-appchain=../appchain \
		--build-context context-protokit=../protokit \
		--file Dockerfile \
		--tag $(docker_image) \
		.
