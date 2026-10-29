mock_provider "azapi" {}

override_data {
  target = data.azapi_resource.production_core_postgres
  values = { output = { properties = { authConfig = { activeDirectoryAuth = "Disabled", passwordAuth = "Enabled" } } } }
}
override_data {
  target = data.azapi_resource.production_existing_ai
  values = { output = { kind = "AIServices", properties = { endpoint = "https://cosmaneuraprodopenai.cognitiveservices.azure.com/", capabilities = [{ name = "realtimeTranscription", value = "true" }] } } }
}
override_data {
  target = data.azapi_resource.production_translation_deployment
  values = { output = { properties = { model = { name = "gpt-4.1", version = "2025-04-14" } } } }
}
override_data {
  target = data.azapi_resource.production_core_app_egress
  values = { output = { properties = { environmentId = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment", outboundIpAddresses = ["64.236.176.41"] } } }
}
override_data {
  target = data.azapi_resource.production_scribe_api_egress
  values = { output = { properties = { environmentId = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment", outboundIpAddresses = ["64.236.176.41"] } } }
}
override_resource {
  target = azurerm_private_endpoint.production_ai
  values = { private_service_connection = { private_ip_address = "10.46.1.7" } }
}
mock_provider "azurerm" {
  mock_resource "azurerm_storage_container" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Storage/storageAccounts/cosmaneurascribeprod/blobServices/default/containers/audio"
    }
  }
  mock_data "azurerm_resource_group" {
    defaults = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production"
      location = "eastus"
    }
  }

  mock_data "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-prod-scribe-workflow"
      client_id    = "c7bae168-fbf5-4658-b0d9-dd4b5373a1be"
      principal_id = "8fecefc9-1577-4afa-b353-83beb5f793f7"
    }
  }

  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.App/managedEnvironments/cosmaneura-scribe-prod-environment"
      default_domain    = "private.synthetic.azurecontainerapps.io"
      static_ip_address = "10.46.2.4"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ContainerRegistry/registries/cosmaneurascribeprod"
      login_server = "cosmaneurascribeprod.azurecr.io"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.KeyVault/vaults/cosmaneura-scribe-prod"
      vault_uri = "https://cosmaneura-scribe-prod.vault.azure.net/"
    }
  }

  mock_resource "azurerm_key_vault_key" {
    defaults = {
      id             = "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping/10000000000000000000000000000000"
      versionless_id = "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping"
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

  mock_resource "azurerm_private_dns_zone" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/privateDnsZones/synthetic.invalid"
    }
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-scribe-prod-pg"
      fqdn = "cosmaneura-scribe-prod-pg.postgres.database.azure.com"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id                    = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Storage/storageAccounts/cosmaneurascribeprod"
      primary_blob_endpoint = "https://cosmaneurascribeprod.blob.core.windows.net/"
    }
  }

  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/virtualNetworks/cosmaneura-scribe-production/subnets/synthetic"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ManagedIdentity/userAssignedIdentities/synthetic"
      client_id    = "20000000-0000-4000-8000-000000000003"
      principal_id = "20000000-0000-4000-8000-000000000004"
    }
  }

  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/virtualNetworks/cosmaneura-scribe-production"
    }
  }
}

override_resource {
  target = azurerm_container_app.api
  values = {
    ingress = {
      fqdn = "cosmaneura-scribe-prod-api.internal.lemonsmoke-1009414c.northcentralus.azurecontainerapps.io"
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

  virtual_network_address_space                  = ["10.46.0.0/16"]
  private_endpoint_subnet_address_prefixes       = ["10.46.1.0/24"]
  container_apps_subnet_address_prefixes         = ["10.46.2.0/23"]
  postgres_subnet_address_prefixes               = ["10.46.4.0/24"]
  production_native_edge_subnet_address_prefixes = ["10.46.6.0/23"]

  deploy_production_existing_host_reuse     = false
  deploy_production_captured_workers        = true
  enable_production_arm_audio_key_bootstrap = true
  production_captured_worker_image_tag      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  production_captured_worker_image_digest   = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  deploy_container_app                      = false
  deploy_postgres_foundation                = false
  deploy_database_migration_job             = false
  use_postgres_repository                   = false
  enable_workflow_authentication            = false
  workflow_api_audience                     = "10000000-0000-4000-8000-000000000001"
  trusted_platform_client_id                = "10000000-0000-4000-8000-000000000002"
  container_image_tag                       = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  container_image_digest                    = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  production_existing_hosting_binding = {
    resource_group_name                      = "cosmaneura-prod"
    location                                 = "northcentralus"
    container_app_environment_id             = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
    container_app_environment_default_domain = "lemonsmoke-1009414c.northcentralus.azurecontainerapps.io"
    container_apps_outbound_ipv4             = "64.236.176.41"
    postgres_server_resource_id              = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
    postgres_server_fqdn                     = "cosmaneura-prod-postgres.postgres.database.azure.com"
  }

  production_native_receiver_image_tag             = "cccccccccccccccccccccccccccccccccccccccc"
  production_native_receiver_image_digest          = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  production_native_receiver_image_contract_sha256 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  production_native_receiver_identity_resource_id  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-prod-scribe-workflow"
  production_native_receiver_identity_client_id    = "c7bae168-fbf5-4658-b0d9-dd4b5373a1be"
  production_core_registry_postgres_resource_id    = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
  production_native_receiver_binding = {
    environment_id                = "30000000-0000-4000-8000-000000000001"
    beta_box_id                   = "30000000-0000-4000-8000-000000000002"
    core_registry_database_host   = "cosmaneura-prod-postgres.postgres.database.azure.com"
    core_registry_database_name   = "production"
    core_registry_database_role   = "scribe_registry_reader"
    core_scope                    = "api://30000000-0000-4000-8000-000000000003/.default"
    audience                      = "cosmaneura-scribe-production"
    organization_id               = "org_synthetic_production"
    ingress_isolation_receipt     = "synthetic-production-ingress-v1"
    deployment_receipt_sha256     = "1111111111111111111111111111111111111111111111111111111111111111"
    session_claims_receipt_sha256 = "2222222222222222222222222222222222222222222222222222222222222222"
    native_policy_receipt_sha256  = "3333333333333333333333333333333333333333333333333333333333333333"
    protected_data_receipt_sha256 = "4444444444444444444444444444444444444444444444444444444444444444"
  }
}

run "dark_workers_use_current_runner_and_private_existing_services" {
  command = plan

  assert {
    condition = (
      length(azurerm_container_app.api) == 0 &&
      length(azurerm_container_app.production_native_receiver) == 0 &&
      length(azurerm_postgresql_flexible_server.scribe) == 0 &&
      length(azurerm_container_app_environment.production_native_edge) == 0 &&
      length(azurerm_cognitive_account.speech) == 0 &&
      length(azurerm_container_app_job.transcription) == 0 &&
      length(azurerm_container_app_job.production_captured) == 2 &&
      length(azurerm_private_endpoint.core_registry_postgres) == 1 &&
      length(azurerm_private_endpoint.production_ai) == 1
    )
    error_message = "dark workers must reuse private Scribe hosting, exact Core PostgreSQL and existing AIServices without another paid hosting, server or AI account"
  }

  assert {
    condition = alltrue([for phase, job in azurerm_container_app_job.production_captured :
      job.container_app_environment_id == azurerm_container_app_environment.scribe.id &&
      job.replica_retry_limit == 0 && length(job.manual_trigger_config) == 1 &&
      length(job.schedule_trigger_config) == 0 &&
      job.template[0].container[0].command == tolist(["python", "-m", "cosmaneura_scribe.captured_worker_job_runner"]) &&
      job.template[0].container[0].args == tolist(["UNCONFIGURED", "--pending"]) &&
      { for item in job.template[0].container[0].env : item.name => item.value }["COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED"] == "false" &&
      { for item in job.template[0].container[0].env : item.name => item.value }["COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_TENANT_IDS"] == "[]" &&
      { for item in job.template[0].container[0].env : item.name => item.value }["AZURE_TOKEN_CREDENTIALS"] == "ManagedIdentityCredential" &&
      !contains([for item in job.template[0].container[0].env : item.name], "COSMANEURA_SCRIBE_DATABASE_URL") &&
      { for item in job.template[0].container[0].env : item.name => item.value }["COSMANEURA_SCRIBE_DATABASE_USER"] == azurerm_user_assigned_identity.production_captured[phase].name &&
      { for item in job.template[0].container[0].env : item.name => item.value }["COSMANEURA_SCRIBE_DATABASE_POOL_SIZE"] == "1" &&
      { for item in job.template[0].container[0].env : item.name => item.value }["COSMANEURA_SCRIBE_DATABASE_MAX_OVERFLOW"] == "0"
    ])
    error_message = "the actual capture runner requires role-specific MI PostgreSQL, one bounded pool, no DATABASE_URL, and no cohort or schedule in the dark rung"
  }

  assert {
    condition = (
      azurerm_user_assigned_identity.production_captured["speech"].name != azurerm_user_assigned_identity.production_captured["translation"].name &&
      length(azurerm_role_assignment.production_captured_key_crypto_user) == 0 &&
      length(azurerm_role_assignment.production_captured_ai) == 0 &&
      length(azurerm_role_assignment.production_captured_blob_reader) == 0 &&
      !azurerm_key_vault.scribe.public_network_access_enabled &&
      !azurerm_storage_account.audio.public_network_access_enabled &&
      azurerm_private_endpoint.production_ai[0].private_service_connection[0].private_connection_resource_id == local.production_ai_id &&
      azurerm_private_endpoint.core_registry_postgres[0].private_service_connection[0].private_connection_resource_id == local.production_core_postgres_id &&
      length(azurerm_private_dns_zone.production_ai) == 3
    )
    error_message = "dark identities have no processing grants; both data paths stay private and point at the reviewed existing services"
  }
}

run "network_rung_is_exact_egress_ciphertext_only_and_does_not_start_capture" {
  command = plan
  variables {
    deploy_production_captured_workers                     = false
    prepare_production_existing_host_runtime_network       = true
    enable_production_native_direct_upload                 = true
    production_existing_host_network_policy_receipt_sha256 = "1111111111111111111111111111111111111111111111111111111111111111"
    production_native_upload_policy_receipt_sha256         = "2222222222222222222222222222222222222222222222222222222222222222"
  }
  assert {
    condition = (
      length(azurerm_container_app.api) == 0 &&
      length(azurerm_container_app_job.production_captured) == 0 &&
      azurerm_key_vault.scribe.public_network_access_enabled &&
      azurerm_key_vault.scribe.network_acls[0].default_action == "Deny" &&
      azurerm_key_vault.scribe.network_acls[0].bypass == "None" &&
      azurerm_key_vault.scribe.network_acls[0].ip_rules == toset(["64.236.176.41/32"]) &&
      azurerm_storage_account.audio.public_network_access_enabled &&
      !azurerm_storage_account.audio.shared_access_key_enabled &&
      !azurerm_storage_account.audio.allow_nested_items_to_be_public &&
      azurerm_storage_account.audio.default_to_oauth_authentication &&
      azurerm_storage_container.audio.container_access_type == "private" &&
      azurerm_role_assignment.runtime_audio_key_reader.scope == local.audio_key_versionless_resource_id &&
      endswith(azurerm_role_assignment.runtime_audio_key_reader.role_definition_id, "/21090545-7ca7-4776-b22c-e363652d74d2")
    )
    error_message = "network preparation opens only exact-IP public-key reads and authenticated ciphertext upload; no API, workers, anonymous access or API unwrap grant is permitted"
  }
}

run "worker_activation_refuses_the_observed_entra_auth_disabled_state" {
  command = plan
  variables {
    enable_production_captured_workers                      = true
    production_capture_tenant_id                            = "51000000-0000-4000-8000-000000000001"
    production_captured_worker_qualification_receipt_sha256 = "3333333333333333333333333333333333333333333333333333333333333333"
  }
  expect_failures = [azurerm_container_app_job.production_captured]
}

run "worker_refuses_other_core_database_selector" {
  command = plan
  variables {
    production_core_registry_postgres_resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/other"
  }
  expect_failures = [var.production_core_registry_postgres_resource_id]
}

run "worker_refuses_mutable_image" {
  command = plan
  variables { production_captured_worker_image_digest = "latest" }
  expect_failures = [azurerm_container_app_job.production_captured]
}

run "worker_refuses_zero_cohort" {
  command = plan
  variables { production_capture_tenant_id = "00000000-0000-0000-0000-000000000000" }
  expect_failures = [var.production_capture_tenant_id]
}

run "runtime_refuses_missing_paired_and_private_worker_qualification" {
  command = plan
  variables { enable_production_existing_host_runtime = true }
  expect_failures = [var.enable_production_existing_host_runtime]
}

run "qualified_workers_and_existing_host_api_use_scoped_runtime_contract" {
  command = plan
  override_data {
    target = data.azapi_resource.production_core_postgres
    values = { output = { properties = { authConfig = { activeDirectoryAuth = "Enabled", passwordAuth = "Enabled" } } } }
  }
  variables {
    deploy_production_existing_host_reuse                         = true
    deploy_container_app                                          = true
    deploy_database_migration_job                                 = true
    use_postgres_repository                                       = true
    enable_workflow_authentication                                = true
    enable_capture_protocol                                       = true
    prepare_production_existing_host_runtime_network              = true
    enable_production_native_direct_upload                        = true
    production_existing_host_network_policy_receipt_sha256        = "1111111111111111111111111111111111111111111111111111111111111111"
    production_native_upload_policy_receipt_sha256                = "2222222222222222222222222222222222222222222222222222222222222222"
    enable_production_captured_workers                            = true
    production_capture_tenant_id                                  = "51000000-0000-4000-8000-000000000001"
    production_captured_worker_qualification_receipt_sha256       = "3333333333333333333333333333333333333333333333333333333333333333"
    enable_production_existing_host_runtime                       = true
    production_existing_host_runtime_qualification_receipt_sha256 = "4444444444444444444444444444444444444444444444444444444444444444"
  }
  assert {
    condition = (
      azurerm_container_app.api[0].template[0].min_replicas == 1 &&
      !azurerm_container_app.api[0].ingress[0].external_enabled &&
      { for item in azurerm_container_app.api[0].template[0].container[0].env : item.name => item.value }["AZURE_TOKEN_CREDENTIALS"] == "ManagedIdentityCredential" &&
      { for item in azurerm_container_app.api[0].template[0].container[0].env : item.name => item.value }["COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_ENABLED"] == "true" &&
      { for item in azurerm_container_app.api[0].template[0].container[0].env : item.name => item.value }["COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_CONTINUATION_ENABLED"] == "true" &&
      alltrue([for role in azurerm_role_assignment.production_captured_key_crypto_user : role.scope == local.audio_key_versionless_resource_id]) &&
      alltrue([for role in azurerm_role_assignment.production_captured_ai : role.scope == local.production_ai_id]) &&
      azurerm_role_assignment.production_captured_blob_reader[0].scope == azurerm_storage_container.audio.id &&
      alltrue([for phase, job in azurerm_container_app_job.production_captured :
        length(job.schedule_trigger_config) == 1 && length(job.manual_trigger_config) == 0 &&
        { for item in job.template[0].container[0].env : item.name => item.value }["COSMANEURA_SCRIBE_CAPTURED_WORKER_STAGE"] == phase &&
        { for item in job.template[0].container[0].env : item.name => item.value }["COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_TENANT_IDS"] == "[\"51000000-0000-4000-8000-000000000001\"]"
      ])
    )
    error_message = "qualified runtime must enable the actual configured API and independently identified private stages, with private Crypto User/Blob/AI scopes and API Reader only"
  }
}

