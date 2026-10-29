variable "deploy_production_captured_workers" {
  description = "Prepare disabled, separately identified capture speech/translation jobs on the existing private Scribe environment, using the existing Core PostgreSQL and production AIServices account. Creates no hosting, database server, or AI account."
  type        = bool
  default     = false

  validation {
    condition     = !var.deploy_production_captured_workers || (var.environment == "production" && var.enable_production_arm_audio_key_bootstrap && !var.deploy_transcription_job && !var.deploy_private_speech_foundation)
    error_message = "production captured workers require production ARM key custody and must not create the legacy transcription job or another Speech account"
  }
}

variable "enable_production_captured_workers" {
  description = "Activate the two existing private capture-worker roles only after separate database, private-path, encrypted assembly and model qualification. No job is started by this flag's default."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_production_captured_workers ||
      (var.deploy_production_captured_workers && can(regex("^[0-9a-f]{64}$", var.production_captured_worker_qualification_receipt_sha256)) && can(regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.production_capture_tenant_id)) && var.production_capture_tenant_id != "00000000-0000-0000-0000-000000000000")
    )
    error_message = "worker activation requires the deployed private jobs, one real nonzero capture tenant, and its reviewed database/private-path/model receipt"
  }
}

variable "production_capture_tenant_id" {
  description = "Exact authorized production capture cohort. Empty keeps jobs unconfigured and disabled; never populate from a synthetic fixture or invented attestation."
  type        = string
  default     = ""

  validation {
    condition     = var.production_capture_tenant_id == "" || (can(regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.production_capture_tenant_id)) && var.production_capture_tenant_id != "00000000-0000-0000-0000-000000000000")
    error_message = "the capture cohort is either unconfigured or one real nonzero tenant UUID"
  }
}

variable "production_captured_worker_qualification_receipt_sha256" {
  description = "Metadata-only binding to completed database-role/private-assembly/Speech/translation qualification. A hash is not approval."
  type        = string
  default     = ""
}

variable "production_captured_worker_image_tag" {
  description = "Merged Scribe source of the captured_worker_job_runner image."
  type        = string
  default     = "not-deployed"
}

variable "production_captured_worker_image_digest" {
  description = "Already-built immutable image for the current captured-worker entry point. Publication is separate."
  type        = string
  default     = "not-deployed"
}

variable "enable_production_captured_database_permissions" {
  description = "Select the existing database_bootstrap configured-capture role grant rung, not job execution or recording. Requires separate founder-authorized migration and exact cohort."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_production_captured_database_permissions || (var.deploy_production_captured_workers && var.deploy_database_migration_job && var.production_capture_tenant_id != "")
    error_message = "configured worker role bootstrap requires both private identities, the manual migration job and exact cohort"
  }
}

locals {
  production_core_postgres_id       = "/subscriptions/${var.subscription_id}/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
  production_ai_id                  = "/subscriptions/${var.subscription_id}/resourceGroups/cosmaneura-prod/providers/Microsoft.CognitiveServices/accounts/cosmaneuraprodopenai"
  production_ai_endpoint            = "https://cosmaneuraprodopenai.cognitiveservices.azure.com"
  production_translation_endpoint   = "https://cosmaneuraprodopenai.openai.azure.com/openai/v1"
  production_translation_deployment = "gpt-4.1-2025-04-14"
  production_captured_phases        = var.deploy_production_captured_workers ? toset(["speech", "translation"]) : toset([])
  production_private_data_paths     = var.deploy_production_native_edge || var.deploy_production_captured_workers
  production_database_authentication_valid = try(
    data.azapi_resource.production_core_postgres[0].output.properties.authConfig.activeDirectoryAuth == "Enabled" &&
    data.azapi_resource.production_core_postgres[0].output.properties.authConfig.passwordAuth == "Enabled",
    false,
  )
}

# Metadata-only GETs do not adopt Core resources or retrieve account access keys.
data "azapi_resource" "production_core_postgres" {
  count                  = var.deploy_production_captured_workers || var.enable_production_existing_host_runtime ? 1 : 0
  type                   = "Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01"
  resource_id            = local.production_core_postgres_id
  response_export_values = ["properties.authConfig", "properties.fullyQualifiedDomainName"]
}

data "azapi_resource" "production_existing_ai" {
  count                  = var.deploy_production_captured_workers ? 1 : 0
  type                   = "Microsoft.CognitiveServices/accounts@2024-10-01"
  resource_id            = local.production_ai_id
  response_export_values = ["kind", "properties.endpoint", "properties.capabilities"]

  lifecycle {
    postcondition {
      condition = (
        self.output.kind == "AIServices" &&
        trimsuffix(self.output.properties.endpoint, "/") == local.production_ai_endpoint &&
        anytrue([for item in self.output.properties.capabilities : item.name == "realtimeTranscription" && item.value == "true"])
      )
      error_message = "the exact existing production AIServices account must expose its normal Speech endpoint and transcription capability"
    }
  }
}

data "azapi_resource" "production_translation_deployment" {
  count                  = var.deploy_production_captured_workers ? 1 : 0
  type                   = "Microsoft.CognitiveServices/accounts/deployments@2024-10-01"
  resource_id            = "${local.production_ai_id}/deployments/${local.production_translation_deployment}"
  response_export_values = ["properties.model"]

  lifecycle {
    postcondition {
      condition     = self.output.properties.model.name == "gpt-4.1" && self.output.properties.model.version == "2025-04-14"
      error_message = "translation must reuse the existing qualified GPT-4.1 deployment; no deployment is created"
    }
  }
}

resource "azurerm_private_dns_zone" "production_ai" {
  for_each            = var.deploy_production_captured_workers ? toset(["privatelink.cognitiveservices.azure.com", "privatelink.openai.azure.com", "privatelink.services.ai.azure.com"]) : toset([])
  name                = each.value
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "production_ai" {
  for_each              = azurerm_private_dns_zone.production_ai
  name                  = "${local.name_prefix}-ai-${replace(each.key, ".", "-")}-link"
  resource_group_name   = local.resource_group_name
  private_dns_zone_name = each.value.name
  virtual_network_id    = azurerm_virtual_network.scribe.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "production_ai" {
  count               = var.deploy_production_captured_workers ? 1 : 0
  name                = "${local.name_prefix}-existing-ai-pe"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  subnet_id           = azurerm_subnet.private_endpoints.id
  private_service_connection {
    name                           = "${local.name_prefix}-existing-ai-connection"
    private_connection_resource_id = local.production_ai_id
    is_manual_connection           = false
    subresource_names              = ["account"]
  }
  private_dns_zone_group {
    name                 = "existing-ai"
    private_dns_zone_ids = [for zone in azurerm_private_dns_zone.production_ai : zone.id]
  }
  depends_on = [azurerm_subnet_network_security_group_association.private_endpoints, azurerm_private_dns_zone_virtual_network_link.production_ai, data.azapi_resource.production_existing_ai]
  tags       = local.tags
}

resource "azurerm_user_assigned_identity" "production_captured" {
  for_each            = local.production_captured_phases
  name                = "${local.name_prefix}-captured-${each.key}"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  tags                = local.tags
}

resource "azurerm_role_assignment" "production_captured_acr" {
  for_each             = local.production_captured_phases
  scope                = azurerm_container_registry.scribe.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.production_captured[each.key].principal_id
}

resource "azurerm_role_assignment" "production_captured_key_crypto_user" {
  for_each             = var.enable_production_captured_workers ? local.production_captured_phases : toset([])
  scope                = local.audio_key_versionless_resource_id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = azurerm_user_assigned_identity.production_captured[each.key].principal_id
  depends_on           = [azapi_resource.production_audio_key]
}

resource "azurerm_role_assignment" "production_captured_blob_reader" {
  count                = var.enable_production_captured_workers ? 1 : 0
  scope                = azurerm_storage_container.audio.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.production_captured["speech"].principal_id
}

resource "azurerm_role_assignment" "production_captured_ai" {
  for_each             = var.enable_production_captured_workers ? local.production_captured_phases : toset([])
  scope                = local.production_ai_id
  role_definition_name = each.key == "speech" ? "Cognitive Services Speech User" : "Cognitive Services OpenAI User"
  principal_id         = azurerm_user_assigned_identity.production_captured[each.key].principal_id
}

locals {
  production_captured_worker_env = {
    for phase in local.production_captured_phases : phase => merge({
      AZURE_TOKEN_CREDENTIALS                             = "ManagedIdentityCredential"
      COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED           = tostring(var.enable_production_captured_workers)
      COSMANEURA_SCRIBE_CAPTURED_WORKER_STAGE             = phase
      COSMANEURA_SCRIBE_CAPTURED_WORKER_BATCH_SIZE        = "8"
      COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_TENANT_IDS     = jsonencode(var.production_capture_tenant_id == "" ? [] : [var.production_capture_tenant_id])
      COSMANEURA_SCRIBE_REPOSITORY_BACKEND                = "postgres"
      COSMANEURA_SCRIBE_DATABASE_HOST                     = "cosmaneura-prod-postgres.postgres.database.azure.com"
      COSMANEURA_SCRIBE_DATABASE_NAME                     = "cosmaneura_scribe"
      COSMANEURA_SCRIBE_DATABASE_USER                     = azurerm_user_assigned_identity.production_captured[phase].name
      COSMANEURA_SCRIBE_DATABASE_SSL                      = "true"
      COSMANEURA_SCRIBE_DATABASE_POOL_SIZE                = "1"
      COSMANEURA_SCRIBE_DATABASE_MAX_OVERFLOW             = "0"
      COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID        = azurerm_user_assigned_identity.production_captured[phase].client_id
      COSMANEURA_SCRIBE_AUDIO_ENCRYPTION_KEY_ID           = local.audio_key_versionless_id
      COSMANEURA_SCRIBE_TRANSCRIPTION_JOB_ENABLED         = "false"
      COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_ENABLED        = "false"
      COSMANEURA_SCRIBE_EXTERNAL_INGEST_ADMISSION_ENABLED = "false"
      }, phase == "speech" ? {
      COSMANEURA_SCRIBE_DATABASE_TRANSCRIPTION_PRINCIPAL_NAME      = azurerm_user_assigned_identity.production_captured[phase].name
      COSMANEURA_SCRIBE_DATABASE_TRANSCRIPTION_PRINCIPAL_OBJECT_ID = azurerm_user_assigned_identity.production_captured[phase].principal_id
      COSMANEURA_SCRIBE_STORAGE_BACKEND                            = "azure"
      COSMANEURA_SCRIBE_STORAGE_ACCOUNT_URL                        = azurerm_storage_account.audio.primary_blob_endpoint
      COSMANEURA_SCRIBE_STORAGE_CONTAINER_NAME                     = local.audio_container_name
      COSMANEURA_SCRIBE_TRANSCRIPTION_BACKEND                      = var.enable_production_captured_workers ? "azure" : "none"
      COSMANEURA_SCRIBE_AZURE_SPEECH_ENDPOINT                      = local.production_ai_endpoint
      COSMANEURA_SCRIBE_AZURE_SPEECH_PRIVATE_ENDPOINT_CIDRS        = jsonencode(["${azurerm_private_endpoint.production_ai[0].private_service_connection[0].private_ip_address}/32"])
      COSMANEURA_SCRIBE_AUDIO_ASSEMBLY_ENCRYPTED_TEMP_DIRECTORY    = "/mnt/encrypted-assembly"
      } : {
      COSMANEURA_SCRIBE_DATABASE_TRANSLATION_PRINCIPAL_NAME      = azurerm_user_assigned_identity.production_captured[phase].name
      COSMANEURA_SCRIBE_DATABASE_TRANSLATION_PRINCIPAL_OBJECT_ID = azurerm_user_assigned_identity.production_captured[phase].principal_id
      COSMANEURA_SCRIBE_STORAGE_BACKEND                          = "memory"
      COSMANEURA_SCRIBE_TRANSCRIPTION_BACKEND                    = "none"
      COSMANEURA_SCRIBE_AZURE_TRANSLATION_ENDPOINT               = local.production_translation_endpoint
      COSMANEURA_SCRIBE_AZURE_TRANSLATION_DEPLOYMENT             = local.production_translation_deployment
      COSMANEURA_SCRIBE_AZURE_TRANSLATION_PRIVATE_ENDPOINT_CIDRS = jsonencode(["${azurerm_private_endpoint.production_ai[0].private_service_connection[0].private_ip_address}/32"])
    })
  }
}

resource "azurerm_container_app_job" "production_captured" {
  for_each                     = local.production_captured_phases
  name                         = "scribe-prod-captured-${each.key}"
  resource_group_name          = local.resource_group_name
  location                     = local.resource_group_location
  container_app_environment_id = azurerm_container_app_environment.scribe.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 1800
  replica_retry_limit          = 0
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.production_captured[each.key].id]
  }
  registry {
    server   = azurerm_container_registry.scribe.login_server
    identity = azurerm_user_assigned_identity.production_captured[each.key].id
  }
  dynamic "manual_trigger_config" {
    for_each = var.enable_production_captured_workers ? [] : [1]
    content {
      parallelism              = 1
      replica_completion_count = 1
    }
  }
  dynamic "schedule_trigger_config" {
    for_each = var.enable_production_captured_workers ? [1] : []
    content {
      cron_expression          = "* * * * *"
      parallelism              = 1
      replica_completion_count = 1
    }
  }
  template {
    dynamic "volume" {
      for_each = each.key == "speech" ? [1] : []
      content {
        name         = "encrypted-assembly"
        storage_type = "EmptyDir"
      }
    }
    container {
      name    = "worker"
      image   = "${azurerm_container_registry.scribe.login_server}/cosmaneura-scribe-api@${var.production_captured_worker_image_digest}"
      cpu     = 0.5
      memory  = "1Gi"
      command = ["python", "-m", "cosmaneura_scribe.captured_worker_job_runner"]
      args    = [var.production_capture_tenant_id == "" ? "UNCONFIGURED" : var.production_capture_tenant_id, "--pending"]
      dynamic "env" {
        for_each = local.production_captured_worker_env[each.key]
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "volume_mounts" {
        for_each = each.key == "speech" ? [1] : []
        content {
          name = "encrypted-assembly"
          path = "/mnt/encrypted-assembly"
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = can(regex("^[0-9a-f]{40}$", var.production_captured_worker_image_tag)) && can(regex("^sha256:[0-9a-f]{64}$", var.production_captured_worker_image_digest))
      error_message = "captured workers require a merged-source, immutable, separately published image"
    }
    precondition {
      condition     = !var.enable_production_captured_workers || local.production_database_authentication_valid
      error_message = "the Core-owned additive Entra authentication rung must be live, with password authentication retained, before worker activation"
    }
  }
  depends_on = [azurerm_private_endpoint.production_ai, azurerm_private_endpoint.core_registry_postgres, azurerm_role_assignment.production_captured_acr, azurerm_role_assignment.production_captured_key_crypto_user, azurerm_role_assignment.production_captured_blob_reader, azurerm_role_assignment.production_captured_ai]
  tags       = merge(local.tags, { image_source_commit = var.production_captured_worker_image_tag })
}
