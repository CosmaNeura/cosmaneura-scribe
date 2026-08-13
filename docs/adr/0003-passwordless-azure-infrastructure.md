# ADR 0003: Passwordless Azure infrastructure and access

- Status: accepted
- Date: 2026-08-13

## Context

The scribe handles raw clinical audio. The canonical Cosmaneura platform already provisions Azure
with Terraform/OpenTofu and authenticates GitHub Actions through workload identity federation. A
second infrastructure language or long-lived service credentials would increase operational and
credential-management risk.

## Decision

- Use OpenTofu/Terraform for scribe infrastructure, with East US as the default location.
- Use interactive Entra ID authentication through Azure CLI for local infrastructure work.
- Use GitHub OIDC for CI/CD and user-assigned managed identities for deployed workloads.
- Disable Blob shared-key access and issue short-lived, one-object user-delegation SAS grants.
- Use private endpoints for PHI stores and keep real secrets in 1Password and/or Key Vault.
- Use only synthetic or de-identified data until the target Azure services, network path, logging,
  retention, and BAA eligibility are verified.

## Consequences

The product repositories and master platform share one infrastructure workflow, and routine access
does not require an `AZURE_CLIENT_SECRET` or storage account key. Initial deployment requires a
small bootstrap inventory of the existing subscription, network, DNS, state backend, registry, and
Container Apps environment before a reviewed plan can be produced.
