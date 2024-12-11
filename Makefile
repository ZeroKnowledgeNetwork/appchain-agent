docker_image ?= zkn/agent:latest

.PHONY: image
image:
	docker build \
		--build-context context-appchain=../appchain \
		--build-context context-protokit=../protokit \
		--file docker/Dockerfile \
		--tag $(docker_image) \
		.
