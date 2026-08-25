#!/usr/bin/env bash

set -euo pipefail

emit_deploy() {
  printf 'deploy=true\nreason=%s\n' "$1"
}

classify_paths() {
  # Read NUL-delimited paths from stdin. The caller deliberately defaults to a
  # deployment when history cannot be inspected; this classifier likewise
  # deploys for every path it does not explicitly know is unrelated.
  local changed_count=0
  local relevant_count=0
  local unknown_count=0
  local path

  while IFS= read -r -d '' path; do
    changed_count=$((changed_count + 1))

    # Documentation, test-only files, and repository ignore metadata never feed
    # either deployment artifact, even when they live beside preview sources.
    case "${path}" in
      *.md | \
        *.mdx | \
        *.test.* | \
        *.spec.* | \
        */test/* | \
        */tests/* | \
        */testdata/* | \
        .gitignore | \
        */.gitignore | \
        LICENSE | \
        */LICENSE | \
        LICENSE.* | \
        */LICENSE.* | \
        NOTICE | \
        */NOTICE | \
        NOTICE.* | \
        */NOTICE.* | \
        CHANGELOG | \
        */CHANGELOG | \
        CHANGELOG.* | \
        */CHANGELOG.*)
        continue
        ;;
    esac

    case "${path}" in
      .github/workflows/capture-preview-deploy.yml | \
        .github/workflows/ci.yml | \
        .github/scripts/classify-capture-preview-scope.sh | \
        mise.toml | \
        .node-version | \
        .npmrc | \
        package.json | \
        package-lock.json | \
        eslint.config.js | \
        tsconfig.base.json | \
        protocol/capture_protocol_v1.json | \
        infra/preview/* | \
        apps/capture/index.html | \
        apps/capture/package.json | \
        apps/capture/vite.config.ts | \
        apps/capture/vitest.config.ts | \
        apps/capture/public/* | \
        apps/capture/scripts/check-preview-bundle.mjs | \
        apps/capture/src/* | \
        apps/capture-preview-api/* | \
        packages/capture-preview-domain/* | \
        packages/capture-protocol/* | \
        apps/capture/native-plugins/secure-queue/package.json | \
        apps/capture/native-plugins/secure-queue/tsconfig.json | \
        apps/capture/native-plugins/secure-queue/tsconfig.build.json | \
        apps/capture/native-plugins/secure-queue/src/*)
        relevant_count=$((relevant_count + 1))
        ;;

      # These paths are known not to feed the synthetic web/Function artifacts
      # or their live preview infrastructure. New or unclassified paths
      # intentionally do not land here.
      .dockerignore | \
        .env.example | \
        .python-version | \
        Dockerfile | \
        Makefile | \
        alembic.ini | \
        pyproject.toml | \
        uv.lock | \
        alembic/* | \
        services/api/* | \
        tests/* | \
        scripts/*.py | \
        openapi/openapi.json | \
        infra/* | \
        apps/desktop-companion/* | \
        apps/capture/e2e/* | \
        apps/capture/android/* | \
        apps/capture/ios/* | \
        apps/capture/capacitor.config.ts | \
        apps/capture/native-plugins/secure-queue/android/* | \
        apps/capture/native-plugins/secure-queue/ios/* | \
        apps/capture/native-plugins/secure-queue/Package.swift | \
        apps/capture/native-plugins/secure-queue/CosmaneuraScribeCapacitorSecureQueue.podspec | \
        .github/workflows/capture-e2e.yml | \
        .github/workflows/capture-preview.yml | \
        .github/workflows/capture-preview-acceptance.yml | \
        .github/workflows/change-budget.yml | \
        .github/workflows/core-image-provenance.yml)
        ;;

      *)
        unknown_count=$((unknown_count + 1))
        ;;
    esac
  done

  if (( changed_count == 0 )); then
    emit_deploy 'no_changed_paths'
  elif (( relevant_count > 0 )); then
    emit_deploy 'preview_input_changed'
  elif (( unknown_count > 0 )); then
    emit_deploy 'unknown_path_changed'
  else
    printf '%s\n' 'deploy=false' 'reason=known_non_preview_paths_only'
  fi
}

classify_range() {
  local base_sha="$1"
  local head_sha="$2"
  local changed_paths

  if [[ ! "${base_sha}" =~ ^[0-9a-f]{40}$ || ! "${head_sha}" =~ ^[0-9a-f]{40}$ ]]; then
    emit_deploy 'invalid_range'
    return
  fi
  if ! git cat-file -e "${base_sha}^{commit}" || ! git cat-file -e "${head_sha}^{commit}"; then
    emit_deploy 'history_unavailable'
    return
  fi
  if ! git merge-base --is-ancestor "${base_sha}" "${head_sha}"; then
    emit_deploy 'baseline_not_ancestor'
    return
  fi
  if ! changed_paths="$(mktemp)"; then
    emit_deploy 'temporary_file_unavailable'
    return
  fi
  if ! git diff --name-only --no-renames -z \
    "${base_sha}" "${head_sha}" -- > "${changed_paths}"; then
    rm -f -- "${changed_paths}"
    emit_deploy 'diff_unavailable'
    return
  fi
  classify_paths < "${changed_paths}"
  rm -f -- "${changed_paths}"
}

if (( $# == 0 )); then
  classify_paths
elif [[ "$1" == '--range' && $# == 3 ]]; then
  classify_range "$2" "$3"
else
  emit_deploy 'invalid_invocation'
fi
