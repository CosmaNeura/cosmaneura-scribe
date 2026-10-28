variable "deploy_delivery_reconciler_job" {
  description = "Create the manual delivery reconciler job and its dedicated managed identity."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.deploy_delivery_reconciler_job ||
      (
        var.deploy_postgres_foundation &&
        can(regex("^[0-9a-f]{40}$", var.container_image_tag))
      )
    )
    error_message = "deploy_delivery_reconciler_job requires PostgreSQL and a lowercase 40-character commit SHA image tag"
  }
}

variable "enable_delivery_reconciler_job" {
  description = "Enable governed tenant-scoped manual delivery reconciliation and its database principal."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_delivery_reconciler_job ||
      (
        var.deploy_delivery_reconciler_job &&
        var.deploy_database_migration_job &&
        var.use_postgres_repository &&
        var.enable_master_platform_handoff &&
        var.connect_parallel_platform_vnet
      )
    )
    error_message = "enable_delivery_reconciler_job requires the deployed job and migration path, PostgreSQL cutover, master handoff, and reviewed private platform connectivity"
  }
}

resource "azurerm_user_assigned_identity" "delivery_reconciler" {
  count = var.deploy_delivery_reconciler_job ? 1 : 0

  name                = "${local.name_prefix}-delivery-reconciler"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  tags                = local.tags
}

resource "azurerm_role_assignment" "delivery_reconciler_acr" {
  count = var.deploy_delivery_reconciler_job ? 1 : 0

  scope                            = azurerm_container_registry.scribe.id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d"
  principal_id                     = azurerm_user_assigned_identity.delivery_reconciler[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app_job" "delivery_reconciler" {
  count = var.deploy_delivery_reconciler_job ? 1 : 0

  name                         = "cosmaneura-scribe-${local.environment_short}-delivery"
  resource_group_name          = local.resource_group_name
  location                     = local.resource_group_location
  container_app_environment_id = azurerm_container_app_environment.scribe.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 900
  replica_retry_limit          = 0

  identity {
    type = "UserAssigned"
    identity_ids = [
      azurerm_user_assigned_identity.delivery_reconciler[0].id,
    ]
  }

  registry {
    server   = azurerm_container_registry.scribe.login_server
    identity = azurerm_user_assigned_identity.delivery_reconciler[0].id
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "reconciler"
      image   = local.application_image
      cpu     = 0.5
      memory  = "1Gi"
      command = ["python", "-m", "cosmaneura_scribe.delivery_reconciler_runner"]

      env {
        name  = "AZURE_TOKEN_CREDENTIALS"
        value = "prod"
      }

      env {
        name  = "COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID"
        value = azurerm_user_assigned_identity.delivery_reconciler[0].client_id
      }

      env {
        name  = "COSMANEURA_SCRIBE_DELIVERY_RECONCILER_JOB_ENABLED"
        value = tostring(var.enable_delivery_reconciler_job)
      }

      env {
        name  = "COSMANEURA_SCRIBE_REPOSITORY_BACKEND"
        value = "postgres"
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_HOST"
        value = azurerm_postgresql_flexible_server.scribe[0].fqdn
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_NAME"
        value = azurerm_postgresql_flexible_server_database.scribe[0].name
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_USER"
        value = azurerm_user_assigned_identity.delivery_reconciler[0].name
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_POOL_SIZE"
        value = "1"
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_MAX_OVERFLOW"
        value = "0"
      }

      env {
        name  = "COSMANEURA_SCRIBE_MASTER_PLATFORM_HANDOFF_ENABLED"
        value = tostring(var.enable_delivery_reconciler_job)
      }

      dynamic "env" {
        for_each = var.enable_delivery_reconciler_job ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_MASTER_PLATFORM_BASE_URL"
          value = var.master_platform_base_url
        }
      }

      dynamic "env" {
        for_each = var.enable_delivery_reconciler_job ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_MASTER_PLATFORM_SCOPE"
          value = var.master_platform_scope
        }
      }
    }
  }

  depends_on = [
    azurerm_postgresql_flexible_server_database.scribe,
    azurerm_role_assignment.delivery_reconciler_acr,
  ]

  tags = local.tags
}

output "delivery_reconciler_job_name" {
  value = var.deploy_delivery_reconciler_job ? azurerm_container_app_job.delivery_reconciler[0].name : null
}

output "delivery_reconciler_managed_identity_client_id" {
  value = var.deploy_delivery_reconciler_job ? azurerm_user_assigned_identity.delivery_reconciler[0].client_id : null
}

output "delivery_reconciler_managed_identity_principal_id" {
  description = "Entra object ID used for the narrow PostgreSQL principal and platform app-role assignment."
  value       = var.deploy_delivery_reconciler_job ? azurerm_user_assigned_identity.delivery_reconciler[0].principal_id : null
}

output "delivery_reconciler_managed_identity_name" {
  value = var.deploy_delivery_reconciler_job ? azurerm_user_assigned_identity.delivery_reconciler[0].name : null
}

output "delivery_reconciler_managed_identity_id" {
  value = var.deploy_delivery_reconciler_job ? azurerm_user_assigned_identity.delivery_reconciler[0].id : null
}
