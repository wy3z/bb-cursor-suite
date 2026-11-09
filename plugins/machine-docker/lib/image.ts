import { createHash } from "node:crypto";

export const BUILTIN_IMAGE_REPOSITORY = "bb-docker-sandbox";
export const BUILTIN_BASE_TAG = `${BUILTIN_IMAGE_REPOSITORY}:base`;

export const BUILTIN_DOCKERFILE = `FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
        ca-certificates \\
        curl \\
        git \\
        gh \\
        jq \\
        openssh-client \\
        procps \\
        ripgrep \\
        chromium \\
        fonts-liberation \\
        fonts-dejavu-core \\
        fonts-noto-color-emoji \\
    && rm -rf /var/lib/apt/lists/*
ENV NPM_CONFIG_PREFIX=/home/node/.local \\
    PATH=/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER node
WORKDIR /home/node
RUN mkdir -p /home/node/.local/bin
`;

export function builtinImageTag(dockerfile = BUILTIN_DOCKERFILE): string {
  return `${BUILTIN_IMAGE_REPOSITORY}:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}
