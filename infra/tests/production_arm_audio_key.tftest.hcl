mock_provider "azapi" {}

mock_provider "azurerm" {
  mock_data "azurerm_resource_group" {
    defaults = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production"
      location = "eastus"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.KeyVault/vaults/cosmaneura-scribe-prod"
      vault_uri = "https://cosmaneura-scribe-prod.vault.azure.net/"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id                    = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Storage/storageAccounts/cosmaneurascribeprod"
      primary_blob_endpoint = "https://cosmaneurascribeprod.blob.core.windows.net/"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ContainerRegistry/registries/cosmaneurascribeprod"
      login_server = "cosmaneurascribeprod.azurecr.io"
    }
  }

  mock_resource "azurerm_key_vault_key" {
    defaults = {
      id             = "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping/10000000000000000000000000000000"
      versionless_id = "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping"
      resource_id    = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.KeyVault/vaults/cosmaneura-scribe-prod/keys/session-audio-wrapping"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-scribe-production-runtime"
      client_id    = "20000000-0000-4000-8000-000000000003"
      principal_id = "20000000-0000-4000-8000-000000000004"
    }
  }

  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/virtualNetworks/cosmaneura-scribe-production/subnets/synthetic"
    }
  }

  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/virtualNetworks/cosmaneura-scribe-production"
    }
  }

  mock_resource "azurerm_private_dns_zone" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/privateDnsZones/synthetic.invalid"
    }
  }

  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.OperationalInsights/workspaces/cosmaneura-scribe-production-logs"
    }
  }

  mock_resource "azurerm_network_security_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/networkSecurityGroups/cosmaneura-scribe-production-nsg"
    }
  }

  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.App/managedEnvironments/cosmaneura-scribe-production-environment"
      default_domain    = "private.synthetic.azurecontainerapps.io"
      static_ip_address = "10.46.2.4"
    }
  }
}

variables {
  subscription_id         = "00000000-0000-0000-0000-000000000000"
  tenant_id               = "00000000-0000-4000-8000-000000000001"
  environment             = "production"
  resource_group_name     = "cosmaneura-scribe-production"
  storage_account_name    = "cosmaneurascribeprod"
  key_vault_name          = "cosmaneura-scribe-prod"
  container_registry_name = "cosmaneurascribeprod"
}

run "default_preserves_the_azurerm_owner" {
  command = plan

  assert {
    condition = (
      !var.enable_production_arm_audio_key_bootstrap &&
      length(azapi_resource.production_audio_key) == 0 &&
      length(azurerm_key_vault_key.audio) == 1 &&
      azurerm_key_vault_key.audio[0].key_type == "RSA" &&
      azurerm_key_vault_key.audio[0].key_size == 3072 &&
      output.audio_encryption_key_id == azurerm_key_vault_key.audio[0].versionless_id
    )
    error_message = "the false default must retain the existing AzureRM key and runtime URI"
  }
}

run "production_bootstrap_uses_only_the_arm_key_and_reader" {
  command = plan

  variables {
    enable_production_arm_audio_key_bootstrap = true
  }

  assert {
    condition = (
      length(azurerm_key_vault_key.audio) == 0 &&
      length(azapi_resource.production_audio_key) == 1 &&
      azapi_resource.production_audio_key[0].type == "Microsoft.KeyVault/vaults/keys@2024-11-01" &&
      azapi_resource.production_audio_key[0].parent_id == azurerm_key_vault.scribe.id &&
      azapi_resource.production_audio_key[0].name == "session-audio-wrapping" &&
      azapi_resource.production_audio_key[0].body.properties.kty == "RSA" &&
      azapi_resource.production_audio_key[0].body.properties.keySize == 3072 &&
      toset(azapi_resource.production_audio_key[0].body.properties.keyOps) == toset(["unwrapKey", "wrapKey"]) &&
      azapi_resource.production_audio_key[0].body.properties.attributes.enabled &&
      !azapi_resource.production_audio_key[0].body.properties.attributes.exportable &&
      azapi_resource.production_audio_key[0].schema_validation_enabled &&
      length(azapi_resource.production_audio_key[0].response_export_values) == 0
    )
    error_message = "production must create one non-exportable RSA3072 ARM child with only wrapping operations and no exported key material"
  }

  assert {
    condition = (
      output.audio_encryption_key_id == "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping" &&
      azurerm_role_assignment.runtime_audio_key_reader.scope == "${azurerm_key_vault.scribe.id}/keys/session-audio-wrapping" &&
      endswith(azurerm_role_assignment.runtime_audio_key_reader.role_definition_id, "/21090545-7ca7-4776-b22c-e363652d74d2") &&
      azurerm_role_assignment.runtime_audio_key_reader.principal_id == azurerm_user_assigned_identity.runtime.principal_id &&
      length(azurerm_role_assignment.transcription_audio_key_crypto_user) == 0
    )
    error_message = "the API must receive key-scoped Reader only; the bootstrap must not create unwrap/crypto-user access"
  }

  assert {
    condition = (
      !azurerm_key_vault.scribe.public_network_access_enabled &&
      !azurerm_storage_account.audio.public_network_access_enabled &&
      length(azurerm_container_app.api) == 0 &&
      length(azurerm_container_app.production_native_receiver) == 0 &&
      length(azurerm_postgresql_flexible_server.scribe) == 0 &&
      length(azurerm_postgresql_flexible_server_database.scribe) == 0 &&
      length(azurerm_container_app_job.database_migrations) == 0 &&
      length(azurerm_container_app_job.transcription) == 0 &&
      length(azurerm_cognitive_account.speech) == 0 &&
      !var.enable_capture_protocol &&
      !var.enable_master_platform_handoff
    )
    error_message = "key bootstrap must preserve private custody and deploy no application, database, processing or traffic"
  }
}

run "nonproduction_cannot_select_the_arm_owner" {
  command = plan

  variables {
    environment                               = "staging"
    enable_production_arm_audio_key_bootstrap = true
  }

  expect_failures = [var.enable_production_arm_audio_key_bootstrap]
}
