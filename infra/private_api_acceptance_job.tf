variable "deploy_private_api_acceptance_job" {
  description = "Create the dormant, manual private API key-metadata acceptance job."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.deploy_private_api_acceptance_job ||
      (
        var.environment == "development" &&
        var.deploy_container_app &&
        can(regex("^[0-9a-f]{40}$", var.private_api_acceptance_image_tag)) &&
        can(regex("^sha256:[0-9a-f]{64}$", var.private_api_acceptance_image_digest)) &&
        can(regex(
          "^/subscriptions/[^/]+/resourcegroups/[^/]+/providers/microsoft\\.managedidentity/userassignedidentities/[^/]+$",
          lower(var.platform_workflow_identity_resource_id),
        )) &&
        startswith(
          lower(var.platform_workflow_identity_resource_id),
          "/subscriptions/${lower(var.subscription_id)}/",
        )
      )
    )
    error_message = "the private API acceptance job is development-only and requires the deployed API, a commit SHA plus image digest, and the exact existing platform workflow UAMI in this subscription"
  }
}

variable "enable_private_api_acceptance_job" {
  description = "Configure the dormant job for the authenticated private key-metadata proof."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_private_api_acceptance_job ||
      (
        var.deploy_private_api_acceptance_job &&
        var.enable_workflow_authentication &&
        can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.workflow_api_audience)) &&
        can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.trusted_platform_client_id)) &&
        can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.private_api_acceptance_tenant_id)) &&
        var.private_api_acceptance_tenant_id != "00000000-0000-0000-0000-000000000000"
      )
    )
    error_message = "private API acceptance enablement requires the deployed job, workflow authentication, exact API audience/caller, and a synthetic tenant UUID"
  }
}

variable "allow_private_api_acceptance_invocation" {
  description = "Open the final raw one-shot invocation gate after the exact job template is reviewed."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.allow_private_api_acceptance_invocation ||
      var.enable_private_api_acceptance_job
    )
    error_message = "private API acceptance invocation requires enable_private_api_acceptance_job=true"
  }
}

variable "private_terraform_reconciliation_completed" {
  description = "Validation-only external attestation that the reviewed private key/API saved plan applied successfully."
  type        = bool
  default     = false
}

variable "platform_workflow_identity_resource_id" {
  description = "Exact resource ID of the existing platform workflow UAMI already assigned Scribe.Workflow.Access."
  type        = string
  default     = ""
}

variable "private_api_acceptance_tenant_id" {
  description = "Synthetic practice-tenant UUID used only as authenticated request context."
  type        = string
  default     = ""
}

variable "private_api_acceptance_image_tag" {
  description = "Reviewed source commit SHA used to build the private API acceptance image."
  type        = string
  default     = "not-deployed"
}

variable "private_api_acceptance_image_digest" {
  description = "Immutable digest for the private API acceptance image built from its source commit."
  type        = string
  default     = "not-deployed"
}

locals {
  platform_workflow_identity_parts = split(
    "/",
    trimprefix(var.platform_workflow_identity_resource_id, "/"),
  )
  platform_workflow_identity_resource_group = try(
    local.platform_workflow_identity_parts[3],
    "disabled",
  )
  platform_workflow_identity_name = try(
    local.platform_workflow_identity_parts[7],
    "disabled",
  )
}

data "azurerm_user_assigned_identity" "platform_workflow" {
  count = var.deploy_private_api_acceptance_job ? 1 : 0

  name                = local.platform_workflow_identity_name
  resource_group_name = local.platform_workflow_identity_resource_group
}

resource "azurerm_role_assignment" "private_api_acceptance_acr" {
  count = var.deploy_private_api_acceptance_job ? 1 : 0

  scope                            = azurerm_container_registry.scribe.id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d"
  principal_id                     = data.azurerm_user_assigned_identity.platform_workflow[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app_job" "private_api_acceptance" {
  count = var.deploy_private_api_acceptance_job ? 1 : 0

  name                         = "cosmaneura-scribe-${local.environment_short}-api-proof"
  resource_group_name          = local.resource_group_name
  location                     = local.resource_group_location
  container_app_environment_id = azurerm_container_app_environment.scribe.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 300
  replica_retry_limit          = 0

  identity {
    type = "UserAssigned"
    identity_ids = [
      data.azurerm_user_assigned_identity.platform_workflow[0].id,
    ]
  }

  registry {
    server   = azurerm_container_registry.scribe.login_server
    identity = data.azurerm_user_assigned_identity.platform_workflow[0].id
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "acceptance"
      image   = "${azurerm_container_registry.scribe.login_server}/cosmaneura-scribe-api@${var.private_api_acceptance_image_digest}"
      cpu     = 0.5
      memory  = "1Gi"
      command = ["python", "-m", "cosmaneura_scribe.private_api_acceptance_runner"]

      env {
        name  = "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_ENABLED"
        value = tostring(var.enable_private_api_acceptance_job)
      }

      env {
        name  = "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED"
        value = tostring(var.allow_private_api_acceptance_invocation)
      }

      dynamic "env" {
        for_each = var.enable_private_api_acceptance_job ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID"
          value = data.azurerm_user_assigned_identity.platform_workflow[0].client_id
        }
      }

      dynamic "env" {
        for_each = var.enable_private_api_acceptance_job ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_WORKFLOW_API_AUDIENCE"
          value = var.workflow_api_audience
        }
      }

      dynamic "env" {
        for_each = var.enable_private_api_acceptance_job ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_BASE_URL"
          value = "https://${local.container_app_name}.${azurerm_container_app_environment.scribe.default_domain}"
        }
      }

      dynamic "env" {
        for_each = var.enable_private_api_acceptance_job ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_TENANT_ID"
          value = var.private_api_acceptance_tenant_id
        }
      }

      dynamic "env" {
        for_each = var.enable_private_api_acceptance_job ? [1] : []
        content {
          name = "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_PRIVATE_ENDPOINT_CIDRS"
          value = jsonencode([
            "${azurerm_container_app_environment.scribe.static_ip_address}/32"
          ])
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition = (
        lower(data.azurerm_user_assigned_identity.platform_workflow[0].id) ==
        lower(var.platform_workflow_identity_resource_id)
      )
      error_message = "the resolved platform workflow identity must exactly match platform_workflow_identity_resource_id"
    }

    precondition {
      condition = (
        lower(data.azurerm_user_assigned_identity.platform_workflow[0].client_id) ==
        lower(var.trusted_platform_client_id)
      )
      error_message = "the attached platform workflow identity must be the exact trusted Scribe caller"
    }
  }

  depends_on = [
    azurerm_private_dns_a_record.container_apps_wildcard,
    azurerm_role_assignment.private_api_acceptance_acr,
  ]

  tags = merge(local.tags, {
    image_source_commit = var.private_api_acceptance_image_tag
  })
}

output "private_api_acceptance_job_name" {
  description = "Dormant manual acceptance job; no caller start permission is created by this stack."
  value       = var.deploy_private_api_acceptance_job ? azurerm_container_app_job.private_api_acceptance[0].name : null
}
