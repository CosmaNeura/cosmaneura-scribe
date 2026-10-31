# Secretless provider mocks only: no backend, cloud, state or live plan/apply.
# Known non-secret source selectors exercise exact binding; no capture data.
mock_provider "azapi" {}

mock_provider "azurerm" {
  mock_resource "azurerm_role_definition" {
    defaults = {
      role_definition_resource_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/providers/Microsoft.Authorization/roleDefinitions/71a6b02f-294d-5734-8721-007ff54f4f67"
    }
  }

  mock_data "azurerm_resource_group" {
    defaults = {
      id       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production"
      location = "eastus"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.KeyVault/vaults/cosmaneura-scribe-prod"
      vault_uri = "https://cosmaneura-scribe-prod.vault.azure.net/"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id                    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Storage/storageAccounts/cosmaneurascribeprod"
      primary_blob_endpoint = "https://cosmaneurascribeprod.blob.core.windows.net/"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ContainerRegistry/registries/cosmaneurascribeprod"
      login_server = "cosmaneurascribeprod.azurecr.io"
    }
  }

  mock_resource "azurerm_key_vault_key" {
    defaults = {
      id             = "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping/10000000000000000000000000000000"
      versionless_id = "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping"
      resource_id    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.KeyVault/vaults/cosmaneura-scribe-prod/keys/session-audio-wrapping"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-scribe-production-runtime"
      client_id    = "39d00a14-ca79-4cbf-8821-3e2af90ea0e2"
      principal_id = "3f712a80-f393-49d0-ab42-6a40bc50dfbd"
    }
  }

  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/virtualNetworks/cosmaneura-scribe-production/subnets/synthetic"
    }
  }

  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/virtualNetworks/cosmaneura-scribe-production"
    }
  }

  mock_resource "azurerm_private_dns_zone" {
    defaults = {
      id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/privateDnsZones/synthetic.invalid"
    }
  }

  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.OperationalInsights/workspaces/cosmaneura-scribe-production-logs"
    }
  }

  mock_resource "azurerm_network_security_group" {
    defaults = {
      id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/networkSecurityGroups/cosmaneura-scribe-production-nsg"
    }
  }

  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id                = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.App/managedEnvironments/cosmaneura-scribe-production-environment"
      default_domain    = "private.synthetic.azurecontainerapps.io"
      static_ip_address = "10.46.2.4"
    }
  }
}

variables {
  subscription_id         = "bab2a709-1fcb-4c87-a9fc-802f7477ec13"
  tenant_id               = "00000000-0000-4000-8000-000000000001"
  environment             = "production"
  resource_group_name     = "cosmaneura-scribe-production"
  storage_account_name    = "cosmaneurascribeprod"
  key_vault_name          = "cosmaneura-scribe-prod"
  container_registry_name = "cosmaneurascribeprod"
}

override_data {
  target = data.azurerm_user_assigned_identity.production_core_bundle_api
  values = {
    id           = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-prod-scribe-workflow"
    client_id    = "c7bae168-fbf5-4658-b0d9-dd4b5373a1be"
    principal_id = "8fecefc9-1577-4afa-b353-83beb5f793f7"
  }
}

override_data {
  target = data.azurerm_user_assigned_identity.production_core_bundle_speech
  values = {
    id           = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-prod-health-services"
    client_id    = "5696041c-ee89-4ef5-bc5d-fdf846cd7364"
    principal_id = "36cc13e3-293b-45a6-9819-4cee01458de6"
  }
}

override_data {
  target = data.azurerm_user_assigned_identity.production_core_bundle_translation
  values = {
    id           = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-scribe-production-runtime"
    client_id    = "39d00a14-ca79-4cbf-8821-3e2af90ea0e2"
    principal_id = "3f712a80-f393-49d0-ab42-6a40bc50dfbd"
  }
}

run "false_defaults_preserve_the_owned_writer_and_add_no_grants" {
  command = plan

  assert {
    condition = (
      !var.prepare_production_core_bundle_grants &&
      !var.remove_owned_production_translation_blob_writer &&
      length(data.azurerm_user_assigned_identity.production_core_bundle_api) == 0 &&
      length(data.azurerm_user_assigned_identity.production_core_bundle_speech) == 0 &&
      length(data.azurerm_user_assigned_identity.production_core_bundle_translation) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_key) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_ai) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_api_delegator) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_api_audio_upload) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_speech_audio_reader) == 0 &&
      length(azurerm_role_definition.production_core_bundle_audio_upload) == 0 &&
      length(azurerm_role_assignment.runtime_audio) == 1 &&
      azurerm_role_assignment.runtime_audio[0].scope == azurerm_storage_account.audio.id &&
      azurerm_role_assignment.runtime_audio[0].role_definition_name == "Storage Blob Data Contributor" &&
      azurerm_role_assignment.runtime_audio[0].principal_id == azurerm_user_assigned_identity.runtime.principal_id
    )
    error_message = "false defaults must preserve the owned writer and add no selected identity lookup, role or grant"
  }
}

run "selected_iam_has_only_the_exact_stage_rights_and_owned_removal" {
  command = plan

  variables {
    prepare_production_core_bundle_grants           = true
    remove_owned_production_translation_blob_writer = true
  }

  assert {
    condition = (
      length(azurerm_role_assignment.runtime_audio) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_key) == 3 &&
      alltrue([for grant in azurerm_role_assignment.production_core_bundle_key : grant.scope == "${azurerm_key_vault.scribe.id}/keys/session-audio-wrapping"]) &&
      endswith(azurerm_role_assignment.production_core_bundle_key["api"].role_definition_id, "/21090545-7ca7-4776-b22c-e363652d74d2") &&
      azurerm_role_assignment.production_core_bundle_key["speech"].role_definition_name == "Key Vault Crypto User" &&
      azurerm_role_assignment.production_core_bundle_key["translation"].role_definition_name == "Key Vault Crypto User" &&
      alltrue([for stage, grant in azurerm_role_assignment.production_core_bundle_key : grant.principal_id == local.production_core_bundle_identities[stage].principal_id])
    )
    error_message = "only the owned account writer is removed; API must stay key Reader while exact worker identities receive key-scoped unwrap"
  }

  assert {
    condition = (
      azurerm_role_assignment.production_core_bundle_api_delegator[0].scope == azurerm_storage_account.audio.id &&
      azurerm_role_assignment.production_core_bundle_api_delegator[0].role_definition_name == "Storage Blob Delegator" &&
      azurerm_role_assignment.production_core_bundle_api_delegator[0].principal_id == local.production_core_bundle_identities.api.principal_id &&
      azurerm_role_assignment.production_core_bundle_api_audio_upload[0].scope == "${azurerm_storage_account.audio.id}/blobServices/default/containers/audio" &&
      azurerm_role_assignment.production_core_bundle_api_audio_upload[0].principal_id == local.production_core_bundle_identities.api.principal_id &&
      toset(azurerm_role_definition.production_core_bundle_audio_upload[0].permissions[0].data_actions) == toset(["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write"]) &&
      length(azurerm_role_definition.production_core_bundle_audio_upload[0].permissions[0].actions) == 0 &&
      azurerm_role_definition.production_core_bundle_audio_upload[0].assignable_scopes == tolist([local.resource_group_id]) &&
      azurerm_role_assignment.production_core_bundle_speech_audio_reader[0].scope == "${azurerm_storage_account.audio.id}/blobServices/default/containers/audio" &&
      azurerm_role_assignment.production_core_bundle_speech_audio_reader[0].role_definition_name == "Storage Blob Data Reader" &&
      azurerm_role_assignment.production_core_bundle_speech_audio_reader[0].principal_id == local.production_core_bundle_identities.speech.principal_id
    )
    error_message = "API needs delegation plus container create/write only, Speech needs container read only, and translation receives no Blob grant"
  }

  assert {
    condition = (
      length(azurerm_role_assignment.production_core_bundle_ai) == 2 &&
      alltrue([for grant in azurerm_role_assignment.production_core_bundle_ai : grant.scope == "/subscriptions/${var.subscription_id}/resourceGroups/cosmaneura-prod/providers/Microsoft.CognitiveServices/accounts/cosmaneuraprodopenai"]) &&
      azurerm_role_assignment.production_core_bundle_ai["speech"].role_definition_name == "Cognitive Services Speech User" &&
      azurerm_role_assignment.production_core_bundle_ai["translation"].role_definition_name == "Cognitive Services OpenAI User" &&
      alltrue([for stage, grant in azurerm_role_assignment.production_core_bundle_ai : grant.principal_id == local.production_core_bundle_identities[stage].principal_id]) &&
      !azurerm_key_vault.scribe.public_network_access_enabled &&
      !azurerm_storage_account.audio.public_network_access_enabled &&
      !var.enable_production_arm_audio_key_bootstrap &&
      length(azapi_resource.production_audio_key) == 0 &&
      length(azurerm_container_app.api) == 0 &&
      length(azurerm_container_app.production_native_receiver) == 0 &&
      length(azurerm_container_app_job.production_captured) == 0 &&
      length(azurerm_user_assigned_identity.production_captured) == 0 &&
      length(azurerm_user_assigned_identity.database_migrations) == 0 &&
      length(azurerm_postgresql_flexible_server.scribe) == 0 &&
      length(azurerm_postgresql_flexible_server_database.scribe) == 0 &&
      !var.enable_capture_protocol &&
      !var.enable_master_platform_handoff
    )
    error_message = "IAM preparation must grant only the selected existing AI roles and preserve network, key custody, topology, database and activation"
  }
}

run "grant_preparation_cannot_skip_the_owned_writer_removal" {
  command = plan
  variables {
    prepare_production_core_bundle_grants = true
  }
  expect_failures = [var.prepare_production_core_bundle_grants]
}

run "grant_preparation_rejects_activation" {
  command = plan
  variables {
    prepare_production_core_bundle_grants           = true
    remove_owned_production_translation_blob_writer = true
    enable_workflow_authentication                  = true
    workflow_api_audience                           = "00000000-0000-4000-8000-000000000020"
    trusted_platform_client_id                      = "00000000-0000-4000-8000-000000000021"
  }
  expect_failures = [var.remove_owned_production_translation_blob_writer]
}

run "owner_reviewed_revocation_keeps_the_owned_writer_removed" {
  command = plan
  variables {
    remove_owned_production_translation_blob_writer = true
  }
  assert {
    condition = (
      !var.prepare_production_core_bundle_grants &&
      length(azurerm_role_assignment.runtime_audio) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_key) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_ai) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_api_delegator) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_api_audio_upload) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_speech_audio_reader) == 0 &&
      length(azurerm_role_definition.production_core_bundle_audio_upload) == 0 &&
      !azurerm_key_vault.scribe.public_network_access_enabled &&
      !azurerm_storage_account.audio.public_network_access_enabled
    )
    error_message = "owner-reviewed revocation must remove only the new grants/custom role while keeping the broad writer absent and networks unchanged"
  }
}

run "existing_identity_recreation_cannot_redirect_the_grants" {
  command = plan
  variables {
    prepare_production_core_bundle_grants           = true
    remove_owned_production_translation_blob_writer = true
  }
  override_data {
    target = data.azurerm_user_assigned_identity.production_core_bundle_speech
    values = {
      id           = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-prod-health-services"
      client_id    = "00000000-0000-4000-8000-000000000010"
      principal_id = "00000000-0000-4000-8000-000000000011"
    }
  }
  expect_failures = [data.azurerm_user_assigned_identity.production_core_bundle_speech]
}
