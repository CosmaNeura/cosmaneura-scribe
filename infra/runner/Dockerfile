FROM mcr.microsoft.com/azure-cli:2.77.0

ARG OPENTOFU_VERSION=1.12.5
ARG OPENTOFU_LINUX_AMD64_SHA256=a6894d45ae7a17ce83189cce8fe04b5a65f68cefceb62455b5a6a89fa53ab38f

ADD https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}/tofu_${OPENTOFU_VERSION}_linux_amd64.tar.gz /tmp/tofu.tar.gz

RUN command -v sha256sum >/dev/null \
    && command -v python3 >/dev/null \
    && printf '%s  %s\n' "$OPENTOFU_LINUX_AMD64_SHA256" /tmp/tofu.tar.gz | sha256sum --check --strict \
    && python3 -c "import tarfile; archive = tarfile.open('/tmp/tofu.tar.gz', 'r:gz'); archive.extract('tofu', path='/usr/local/bin', filter='data')" \
    && chmod 0555 /usr/local/bin/tofu \
    && rm -f /tmp/tofu.tar.gz

ENV AZURE_CONFIG_DIR=/tmp/.azure \
    HOME=/tmp/runner-home \
    TF_IN_AUTOMATION=true

WORKDIR /workspace/infra

COPY --chown=10001:0 . /workspace/infra

RUN chmod 0555 /workspace/infra/runner/run.sh \
    && command -v az >/dev/null \
    && command -v python3 >/dev/null \
    && command -v tofu >/dev/null \
    && cp /workspace/infra/runner/reconciliation-moves.tf /workspace/infra/reconciliation-moves.tf \
    && mkdir -p /opt/tofu/providers /tmp/.azure /tmp/runner-home \
    && tofu providers mirror -platform=linux_amd64 /opt/tofu/providers \
    && chown -R 10001:0 /workspace/infra /tmp/.azure /tmp/runner-home \
    && TF_CLI_CONFIG_FILE=/workspace/infra/runner/tofurc tofu init -backend=false \
    && chown -R 10001:0 /workspace/infra

USER 10001:0

ENTRYPOINT ["/workspace/infra/runner/run.sh"]
