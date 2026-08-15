resource "azurerm_user_assigned_identity" "transcription" {
  count = var.deploy_transcription_job ? 1 : 0

  name                = "${local.name_prefix}-transcription"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  tags                = local.tags
}

resource "azurerm_role_assignment" "transcription_acr" {
  count = var.deploy_transcription_job ? 1 : 0

  scope                            = azurerm_container_registry.scribe.id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d"
  principal_id                     = azurerm_user_assigned_identity.transcription[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "transcription_audio_reader" {
  count = var.enable_transcription_job ? 1 : 0

  scope                            = azurerm_storage_container.audio.id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/2a2b9908-6ea1-4ae2-8e65-a410df84e7d1"
  principal_id                     = azurerm_user_assigned_identity.transcription[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "transcription_audio_key_crypto_user" {
  count = var.enable_transcription_job ? 1 : 0

  scope                            = azurerm_key_vault_key.audio.resource_id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/12338af0-0e69-4776-bea7-57ae8d297424"
  principal_id                     = azurerm_user_assigned_identity.transcription[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "transcription_speech_user" {
  count = var.enable_transcription_job ? 1 : 0

  scope                            = var.azure_speech_resource_id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/f2dc8367-1007-4938-bd23-fe263f013447"
  principal_id                     = azurerm_user_assigned_identity.transcription[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app_job" "transcription" {
  count = var.deploy_transcription_job ? 1 : 0

  name                         = "cosmaneura-scribe-${local.environment_short}-stt"
  resource_group_name          = local.resource_group_name
  location                     = local.resource_group_location
  container_app_environment_id = azurerm_container_app_environment.scribe.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 1800
  replica_retry_limit          = 0

  identity {
    type = "UserAssigned"
    identity_ids = [
      azurerm_user_assigned_identity.transcription[0].id,
    ]
  }

  registry {
    server   = azurerm_container_registry.scribe.login_server
    identity = azurerm_user_assigned_identity.transcription[0].id
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    volume {
      name         = "encrypted-assembly"
      storage_type = "EmptyDir"
    }

    container {
      name    = "worker"
      image   = "${azurerm_container_registry.scribe.login_server}/${var.container_image_repository}:${var.container_image_tag}"
      cpu     = 0.5
      memory  = "1Gi"
      command = ["python", "-m", "cosmaneura_scribe.transcription_job_runner"]

      volume_mounts {
        name = "encrypted-assembly"
        path = "/mnt/encrypted-assembly"
      }

      env {
        name  = "AZURE_TOKEN_CREDENTIALS"
        value = "prod"
      }

      env {
        name  = "COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID"
        value = azurerm_user_assigned_identity.transcription[0].client_id
      }

      env {
        name  = "COSMANEURA_SCRIBE_TRANSCRIPTION_JOB_ENABLED"
        value = tostring(var.enable_transcription_job)
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
        value = azurerm_user_assigned_identity.transcription[0].name
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
        name  = "COSMANEURA_SCRIBE_STORAGE_BACKEND"
        value = "azure"
      }

      env {
        name  = "COSMANEURA_SCRIBE_STORAGE_ACCOUNT_URL"
        value = azurerm_storage_account.audio.primary_blob_endpoint
      }

      env {
        name  = "COSMANEURA_SCRIBE_STORAGE_CONTAINER_NAME"
        value = azurerm_storage_container.audio.name
      }

      env {
        name  = "COSMANEURA_SCRIBE_AUDIO_ENCRYPTION_KEY_ID"
        value = azurerm_key_vault_key.audio.versionless_id
      }

      env {
        name  = "COSMANEURA_SCRIBE_AUDIO_ASSEMBLY_ENCRYPTED_TEMP_DIRECTORY"
        value = "/mnt/encrypted-assembly"
      }

      env {
        name  = "COSMANEURA_SCRIBE_TRANSCRIPTION_BACKEND"
        value = var.enable_transcription_job ? "azure" : "none"
      }

      dynamic "env" {
        for_each = var.enable_transcription_job ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_AZURE_SPEECH_ENDPOINT"
          value = var.azure_speech_endpoint
        }
      }
    }
  }

  depends_on = [
    azurerm_private_endpoint.audio_blob,
    azurerm_private_endpoint.key_vault,
    azurerm_role_assignment.transcription_acr,
    azurerm_role_assignment.transcription_audio_reader,
    azurerm_role_assignment.transcription_audio_key_crypto_user,
    azurerm_role_assignment.transcription_speech_user,
  ]

  tags = local.tags
}
