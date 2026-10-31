# Secretless provider mocks only: no backend, cloud, state or live plan/apply.
# Known non-secret source selectors exercise exact binding; no capture data.
mock_provider "azapi" {}

mock_provider "azurerm" {
  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production"
    }
  }

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
  subscription_id                                = "bab2a709-1fcb-4c87-a9fc-802f7477ec13"
  tenant_id                                      = "00000000-0000-4000-8000-000000000001"
  environment                                    = "production"
  resource_group_name                            = "cosmaneura-scribe-production"
  create_resource_group                          = true
  prepare_production_database_migration_identity = true
  enable_production_arm_audio_key_bootstrap      = true
  retained_production_migration_registry_scope   = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourcegroups/cosmaneura-scribe-production/providers/microsoft.containerregistry/registries/cosmaneurascribeprod"
  storage_account_name                           = "cosmaneurascribeprod"
  key_vault_name                                 = "cosmaneura-scribe-prod"
  container_registry_name                        = "cosmaneurascribeprod"
  production_existing_hosting_binding = {
    resource_group_name                      = "cosmaneura-prod"
    location                                 = "northcentralus"
    container_app_environment_id             = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
    container_app_environment_default_domain = "lemonsmoke-1009414c.northcentralus.azurecontainerapps.io"
    container_apps_outbound_ipv4             = "64.236.176.41"
    postgres_server_resource_id              = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
    postgres_server_fqdn                     = "cosmaneura-prod-postgres.postgres.database.azure.com"
  }
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
      !var.prepare_production_core_bundle_network &&
      !var.enable_production_core_bundle_native_ciphertext_upload &&
      var.production_core_bundle_network_policy_receipt_sha256 == "" &&
      var.production_core_bundle_upload_policy_receipt_sha256 == "" &&
      var.production_core_bundle_hosting_binding == null &&
      length(data.azapi_resource.production_core_bundle_api_egress) == 0 &&
      length(data.azapi_resource.production_core_bundle_worker_egress) == 0 &&
      length(data.azapi_resource.production_core_bundle_scheduler_egress) == 0 &&
      length(azurerm_key_vault.scribe.network_acls) == 0 &&
      length(azurerm_storage_account.audio.blob_properties[0].cors_rule) == 0 &&
      length(data.azurerm_user_assigned_identity.production_core_bundle_api) == 0 &&
      length(data.azurerm_user_assigned_identity.production_core_bundle_speech) == 0 &&
      length(data.azurerm_user_assigned_identity.production_core_bundle_translation) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_key) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_ai) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_api_delegator) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_api_audio_upload) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_speech_audio_reader) == 0 &&
      length(azurerm_role_definition.production_core_bundle_audio_upload) == 0 &&
      length(azurerm_resource_group.scribe) == 1 &&
      length(azurerm_user_assigned_identity.database_migrations) == 1 &&
      length(azurerm_role_assignment.database_migrations_acr) == 1 &&
      azurerm_role_assignment.database_migrations_acr[0].scope == var.retained_production_migration_registry_scope &&
      var.enable_production_arm_audio_key_bootstrap &&
      length(azapi_resource.production_audio_key) == 1 &&
      length(azurerm_key_vault_key.audio) == 0 &&
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
      var.enable_production_arm_audio_key_bootstrap &&
      length(azapi_resource.production_audio_key) == 1 &&
      length(azurerm_key_vault_key.audio) == 0 &&
      length(azurerm_container_app.api) == 0 &&
      length(azurerm_container_app.production_native_receiver) == 0 &&
      length(azurerm_container_app_job.production_captured) == 0 &&
      length(azurerm_user_assigned_identity.production_captured) == 0 &&
      length(azurerm_resource_group.scribe) == 1 &&
      length(data.azurerm_resource_group.scribe) == 0 &&
      length(azurerm_user_assigned_identity.database_migrations) == 1 &&
      length(azurerm_role_assignment.database_migrations_acr) == 1 &&
      azurerm_role_assignment.database_migrations_acr[0].scope == var.retained_production_migration_registry_scope &&
      length(azurerm_container_app_job.database_migrations) == 0 &&
      length(azurerm_postgresql_flexible_server_active_directory_administrator.migrations) == 0 &&
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

run "grant_preparation_rejects_owned_resource_group_withdrawal" {
  command = plan
  variables {
    prepare_production_core_bundle_grants           = true
    remove_owned_production_translation_blob_writer = true
    create_resource_group                           = false
  }
  expect_failures = [var.remove_owned_production_translation_blob_writer]
}

run "grant_preparation_rejects_owned_migration_identity_withdrawal" {
  command = plan
  variables {
    prepare_production_core_bundle_grants           = true
    remove_owned_production_translation_blob_writer = true
    prepare_production_database_migration_identity  = false
    retained_production_migration_registry_scope    = null
  }
  expect_failures = [var.remove_owned_production_translation_blob_writer]
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
  expect_failures = [var.prepare_production_database_migration_identity]
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

# The following policy hashes and host responses are synthetic provider mocks.
# They exercise source contracts and confer no owner approval or live access.

override_data {
  target = data.azapi_resource.production_core_bundle_api_egress
  values = {
    output = {
      id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
      properties = {
        environmentId       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
        outboundIpAddresses = ["64.236.176.41"]
      }
    }
  }
}

override_data {
  target = data.azapi_resource.production_core_bundle_worker_egress
  values = {
    output = {
      id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
      properties = {
        environmentId       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
        outboundIpAddresses = ["64.236.176.41"]
      }
    }
  }
}

override_data {
  target = data.azapi_resource.production_core_bundle_scheduler_egress
  values = {
    output = {
      id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
      properties = {
        environmentId       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
        outboundIpAddresses = ["64.236.176.41"]
      }
    }
  }
}

run "core_bundle_routing_preserves_iam_cleanup_and_exact_native_policy" {
  command = plan
  variables {
    prepare_production_core_bundle_grants                  = true
    remove_owned_production_translation_blob_writer        = true
    prepare_production_core_bundle_network                 = true
    enable_production_core_bundle_native_ciphertext_upload = true
    production_core_bundle_network_policy_receipt_sha256   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    production_core_bundle_upload_policy_receipt_sha256    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    production_core_bundle_hosting_binding = {
      container_app_environment_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
      container_app_resource_ids = {
        api       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
        worker    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
        scheduler = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
      }
      container_apps_outbound_ipv4 = "64.236.176.41"
    }
  }

  assert {
    condition = (
      length(data.azapi_resource.production_core_bundle_api_egress) == 1 &&
      length(data.azapi_resource.production_core_bundle_worker_egress) == 1 &&
      length(data.azapi_resource.production_core_bundle_scheduler_egress) == 1 &&
      azurerm_key_vault.scribe.public_network_access_enabled &&
      azurerm_key_vault.scribe.rbac_authorization_enabled &&
      azurerm_key_vault.scribe.purge_protection_enabled &&
      length(azurerm_key_vault.scribe.network_acls) == 1 &&
      azurerm_key_vault.scribe.network_acls[0].default_action == "Deny" &&
      azurerm_key_vault.scribe.network_acls[0].bypass == "None" &&
      toset(azurerm_key_vault.scribe.network_acls[0].ip_rules) == toset(["64.236.176.41/32"]) &&
      length(coalesce(azurerm_key_vault.scribe.network_acls[0].virtual_network_subnet_ids, toset([]))) == 0 &&
      azurerm_storage_account.audio.public_network_access_enabled &&
      !azurerm_storage_account.audio.shared_access_key_enabled &&
      !azurerm_storage_account.audio.allow_nested_items_to_be_public &&
      !azurerm_storage_account.audio.local_user_enabled &&
      azurerm_storage_account.audio.default_to_oauth_authentication &&
      azurerm_storage_account.audio.https_traffic_only_enabled &&
      azurerm_storage_account.audio.min_tls_version == "TLS1_2" &&
      azurerm_storage_container.audio.container_access_type == "private" &&
      azurerm_storage_account.audio.blob_properties[0].versioning_enabled &&
      azurerm_storage_account.audio.blob_properties[0].delete_retention_policy[0].days == 7 &&
      azurerm_storage_account.audio.blob_properties[0].container_delete_retention_policy[0].days == 7 &&
      length(azurerm_storage_account.audio.blob_properties[0].cors_rule) == 1 &&
      toset(azurerm_storage_account.audio.blob_properties[0].cors_rule[0].allowed_origins) == toset(["app://cosmas", "capacitor://localhost"]) &&
      toset(azurerm_storage_account.audio.blob_properties[0].cors_rule[0].allowed_methods) == toset(["OPTIONS", "PUT"]) &&
      toset(azurerm_storage_account.audio.blob_properties[0].cors_rule[0].allowed_headers) == toset(["content-type", "x-ms-blob-type"]) &&
      toset(azurerm_storage_account.audio.blob_properties[0].cors_rule[0].exposed_headers) == toset(["ETag"]) &&
      azurerm_storage_account.audio.blob_properties[0].cors_rule[0].max_age_in_seconds == 300 &&
      length(azurerm_role_assignment.runtime_audio) == 0 &&
      length(azurerm_role_assignment.production_core_bundle_key) == 3 &&
      length(azurerm_role_assignment.production_core_bundle_ai) == 2 &&
      length(azurerm_role_assignment.production_core_bundle_api_delegator) == 1 &&
      length(azurerm_role_assignment.production_core_bundle_api_audio_upload) == 1 &&
      length(azurerm_role_assignment.production_core_bundle_speech_audio_reader) == 1 &&
      length(azurerm_resource_group.scribe) == 1 &&
      length(data.azurerm_resource_group.scribe) == 0 &&
      length(azurerm_user_assigned_identity.database_migrations) == 1 &&
      length(azurerm_role_assignment.database_migrations_acr) == 1 &&
      azurerm_role_assignment.database_migrations_acr[0].scope == var.retained_production_migration_registry_scope &&
      var.enable_production_arm_audio_key_bootstrap &&
      length(azapi_resource.production_audio_key) == 1 &&
      length(azurerm_key_vault_key.audio) == 0 &&
      length(azurerm_container_app_job.database_migrations) == 0 &&
      length(azurerm_postgresql_flexible_server_active_directory_administrator.migrations) == 0 &&
      length(azurerm_container_app.api) == 0 &&
      length(azurerm_container_app.production_native_receiver) == 0 &&
      length(azurerm_container_app_job.production_captured) == 0 &&
      length(azurerm_postgresql_flexible_server.scribe) == 0 &&
      !var.prepare_production_existing_host_runtime_network &&
      !var.enable_production_native_direct_upload &&
      !var.enable_capture_protocol
    )
    error_message = "routing must preserve exact deny-by-default KV egress, authenticated native Blob protections/CORS, persistent IAM and writer cleanup, without obsolete workloads or activation"
  }
}

run "core_bundle_routing_requires_paired_selectors" {
  command = plan
  variables {
    prepare_production_core_bundle_grants                  = true
    remove_owned_production_translation_blob_writer        = true
    prepare_production_core_bundle_network                 = true
    enable_production_core_bundle_native_ciphertext_upload = false
    production_core_bundle_network_policy_receipt_sha256   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    production_core_bundle_upload_policy_receipt_sha256    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    production_core_bundle_hosting_binding = {
      container_app_environment_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
      container_app_resource_ids = {
        api       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
        worker    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
        scheduler = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
      }
      container_apps_outbound_ipv4 = "64.236.176.41"
    }
  }
  expect_failures = [azurerm_storage_account.audio, azurerm_key_vault.scribe]
}

run "core_bundle_routing_requires_upload_policy_hash" {
  command = plan
  variables {
    prepare_production_core_bundle_grants                  = true
    remove_owned_production_translation_blob_writer        = true
    prepare_production_core_bundle_network                 = true
    enable_production_core_bundle_native_ciphertext_upload = true
    production_core_bundle_network_policy_receipt_sha256   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    production_core_bundle_upload_policy_receipt_sha256    = ""
    production_core_bundle_hosting_binding = {
      container_app_environment_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
      container_app_resource_ids = {
        api       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
        worker    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
        scheduler = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
      }
      container_apps_outbound_ipv4 = "64.236.176.41"
    }
  }
  expect_failures = [azurerm_storage_account.audio, azurerm_key_vault.scribe]
}

run "core_bundle_routing_rejects_ingress_as_outbound" {
  command = plan
  variables {
    prepare_production_core_bundle_grants                  = true
    remove_owned_production_translation_blob_writer        = true
    prepare_production_core_bundle_network                 = true
    enable_production_core_bundle_native_ciphertext_upload = true
    production_core_bundle_network_policy_receipt_sha256   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    production_core_bundle_upload_policy_receipt_sha256    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    production_core_bundle_hosting_binding = {
      container_app_environment_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
      container_app_resource_ids = {
        api       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
        worker    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
        scheduler = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
      }
      container_apps_outbound_ipv4 = "135.224.13.80"
    }
  }
  expect_failures = [azurerm_storage_account.audio, azurerm_key_vault.scribe]
}

run "core_bundle_routing_rejects_obsolete_activation_mode" {
  command = plan
  variables {
    prepare_production_core_bundle_grants                  = true
    remove_owned_production_translation_blob_writer        = true
    prepare_production_core_bundle_network                 = true
    enable_production_core_bundle_native_ciphertext_upload = true
    production_core_bundle_network_policy_receipt_sha256   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    production_core_bundle_upload_policy_receipt_sha256    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    enable_workflow_authentication                         = true
    workflow_api_audience                                  = "00000000-0000-4000-8000-000000000020"
    trusted_platform_client_id                             = "00000000-0000-4000-8000-000000000021"
    production_core_bundle_hosting_binding = {
      container_app_environment_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
      container_app_resource_ids = {
        api       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
        worker    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
        scheduler = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
      }
      container_apps_outbound_ipv4 = "64.236.176.41"
    }
  }
  expect_failures = [var.prepare_production_database_migration_identity]
}

run "core_bundle_routing_rejects_api_metadata_drift" {
  command = plan
  variables {
    prepare_production_core_bundle_grants                  = true
    remove_owned_production_translation_blob_writer        = true
    prepare_production_core_bundle_network                 = true
    enable_production_core_bundle_native_ciphertext_upload = true
    production_core_bundle_network_policy_receipt_sha256   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    production_core_bundle_upload_policy_receipt_sha256    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    production_core_bundle_hosting_binding = {
      container_app_environment_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
      container_app_resource_ids = {
        api       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
        worker    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
        scheduler = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
      }
      container_apps_outbound_ipv4 = "64.236.176.41"
    }
  }
  override_data {
    target = data.azapi_resource.production_core_bundle_api_egress
    values = {
      output = {
        id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/unselected"
        properties = {
          environmentId       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
          outboundIpAddresses = ["64.236.176.41"]
        }
      }
    }
  }
  expect_failures = [data.azapi_resource.production_core_bundle_api_egress]
}

run "core_bundle_routing_rejects_worker_metadata_drift" {
  command = plan
  variables {
    prepare_production_core_bundle_grants                  = true
    remove_owned_production_translation_blob_writer        = true
    prepare_production_core_bundle_network                 = true
    enable_production_core_bundle_native_ciphertext_upload = true
    production_core_bundle_network_policy_receipt_sha256   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    production_core_bundle_upload_policy_receipt_sha256    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    production_core_bundle_hosting_binding = {
      container_app_environment_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
      container_app_resource_ids = {
        api       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
        worker    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
        scheduler = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
      }
      container_apps_outbound_ipv4 = "64.236.176.41"
    }
  }
  override_data {
    target = data.azapi_resource.production_core_bundle_worker_egress
    values = {
      output = {
        id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
        properties = {
          environmentId       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
          outboundIpAddresses = ["64.236.176.42"]
        }
      }
    }
  }
  expect_failures = [data.azapi_resource.production_core_bundle_worker_egress]
}

run "core_bundle_routing_rejects_scheduler_metadata_drift" {
  command = plan
  variables {
    prepare_production_core_bundle_grants                  = true
    remove_owned_production_translation_blob_writer        = true
    prepare_production_core_bundle_network                 = true
    enable_production_core_bundle_native_ciphertext_upload = true
    production_core_bundle_network_policy_receipt_sha256   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    production_core_bundle_upload_policy_receipt_sha256    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    production_core_bundle_hosting_binding = {
      container_app_environment_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
      container_app_resource_ids = {
        api       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
        worker    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
        scheduler = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
      }
      container_apps_outbound_ipv4 = "64.236.176.41"
    }
  }
  override_data {
    target = data.azapi_resource.production_core_bundle_scheduler_egress
    values = {
      output = {
        id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
        properties = {
          environmentId       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/unselected"
          outboundIpAddresses = ["64.236.176.41"]
        }
      }
    }
  }
  expect_failures = [data.azapi_resource.production_core_bundle_scheduler_egress]
}
