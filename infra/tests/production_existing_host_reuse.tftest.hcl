mock_provider "azurerm" {
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

  deploy_production_existing_host_reuse = true
  deploy_container_app                  = true
  deploy_postgres_foundation            = false
  deploy_database_migration_job         = true
  use_postgres_repository               = true
  enable_workflow_authentication        = true
  workflow_api_audience                 = "10000000-0000-4000-8000-000000000001"
  trusted_platform_client_id            = "10000000-0000-4000-8000-000000000002"
  container_image_tag                   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  container_image_digest                = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

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

run "existing_host_reuse_is_dark_and_creates_no_paid_foundation" {
  command = plan

  assert {
    condition = (
      length(azurerm_container_app_environment.production_native_edge) == 0 &&
      length(azurerm_subnet.production_native_edge) == 0 &&
      length(azurerm_network_security_group.production_native_edge) == 0 &&
      length(azurerm_private_endpoint.core_registry_postgres) == 0 &&
      length(azurerm_postgresql_flexible_server.scribe) == 0 &&
      length(azurerm_postgresql_flexible_server_active_directory_administrator.migrations) == 0 &&
      length(azurerm_monitor_diagnostic_setting.postgres) == 0
    )
    error_message = "reuse mode must not create a Container Apps environment, PostgreSQL server, network edge, or duplicate diagnostics"
  }

  assert {
    condition = (
      length(azurerm_postgresql_flexible_server_database.scribe) == 1 &&
      azurerm_postgresql_flexible_server_database.scribe[0].name == "cosmaneura_scribe" &&
      lower(azurerm_postgresql_flexible_server_database.scribe[0].server_id) == lower(var.production_existing_hosting_binding.postgres_server_resource_id) &&
      length(azurerm_user_assigned_identity.database_migrations) == 1 &&
      length(azurerm_container_app_job.database_migrations) == 1 &&
      azurerm_container_app_job.database_migrations[0].resource_group_name == "cosmaneura-prod" &&
      azurerm_container_app_job.database_migrations[0].location == "northcentralus" &&
      lower(azurerm_container_app_job.database_migrations[0].container_app_environment_id) == lower(var.production_existing_hosting_binding.container_app_environment_id) &&
      azurerm_container_app_job.database_migrations[0].replica_retry_limit == 0
    )
    error_message = "reuse mode must create only the isolated logical database, migration identity, and one-shot job on the reviewed existing hosts"
  }

  assert {
    condition = (
      !azurerm_container_app.api[0].ingress[0].external_enabled &&
      azurerm_container_app.api[0].resource_group_name == "cosmaneura-prod" &&
      lower(azurerm_container_app.api[0].container_app_environment_id) == lower(var.production_existing_hosting_binding.container_app_environment_id) &&
      azurerm_container_app.api[0].template[0].min_replicas == 0 &&
      azurerm_container_app.api[0].template[0].container[0].image == "cosmaneurascribeprod.azurecr.io/cosmaneura-scribe-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" &&
      {
        for value in azurerm_container_app.api[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_CAPTURE_PROTOCOL_ENABLED"] == "false" &&
      {
        for value in azurerm_container_app.api[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_MASTER_PLATFORM_HANDOFF_ENABLED"] == "false" &&
      {
        for value in azurerm_container_app.api[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_DATABASE_HOST"] == var.production_existing_hosting_binding.postgres_server_fqdn &&
      {
        for value in azurerm_container_app.api[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_DATABASE_NAME"] == "cosmaneura_scribe" &&
      {
        for value in azurerm_container_app.api[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_DATABASE_POOL_SIZE"] == "2" &&
      {
        for value in azurerm_container_app.api[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_DATABASE_MAX_OVERFLOW"] == "0"
    )
    error_message = "the existing-host API must remain internal, scaled to zero, immutable, behaviorally dark, and conservatively pooled"
  }

  assert {
    condition = (
      output.production_workflow_api_origin == "https://cosmaneura-scribe-prod-api.internal.lemonsmoke-1009414c.northcentralus.azurecontainerapps.io" &&
      output.production_workflow_api_origin == "https://${azurerm_container_app.api[0].ingress[0].fqdn}" &&
      output.production_workflow_api_origin != "https://${local.container_app_name}.${var.production_existing_hosting_binding.container_app_environment_default_domain}"
    )
    error_message = "reuse mode must export Azure's actual internal-ingress FQDN, including the distinct internal domain segment, rather than composing an external hostname"
  }

  assert {
    condition = (
      length(azurerm_container_app.production_native_receiver) == 1 &&
      azurerm_container_app.production_native_receiver[0].resource_group_name == "cosmaneura-prod" &&
      lower(azurerm_container_app.production_native_receiver[0].container_app_environment_id) == lower(var.production_existing_hosting_binding.container_app_environment_id) &&
      azurerm_container_app.production_native_receiver[0].template[0].min_replicas == 0 &&
      jsondecode(nonsensitive({
        for value in azurerm_container_app.production_native_receiver[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"])).enabled == false &&
      jsondecode(nonsensitive({
        for value in azurerm_container_app.production_native_receiver[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"])).encounter_creation_enabled == false
    )
    error_message = "the receiver must bind the existing environment at scale zero with provider and encounter behavior disabled"
  }

  assert {
    condition = (
      azurerm_container_app_environment.scribe.internal_load_balancer_enabled &&
      azurerm_container_app_environment.scribe.public_network_access == "Disabled" &&
      !azurerm_storage_account.audio.public_network_access_enabled &&
      !azurerm_key_vault.scribe.public_network_access_enabled &&
      length(azurerm_cognitive_account.speech) == 0 &&
      length(azurerm_container_app_job.transcription) == 0 &&
      length(azurerm_container_app_job.delivery_reconciler) == 0
    )
    error_message = "reuse mode must preserve the applied private foundation and leave processing capacity absent"
  }
}

run "reuse_refuses_the_dedicated_edge_at_the_same_time" {
  command = plan

  variables {
    deploy_production_native_edge = true
    deploy_postgres_foundation    = true
  }

  expect_failures = [
    var.deploy_production_native_edge,
  ]
}

run "reuse_refuses_a_different_container_apps_environment" {
  command = plan

  variables {
    production_existing_hosting_binding = {
      resource_group_name                      = "cosmaneura-prod"
      location                                 = "northcentralus"
      container_app_environment_id             = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/not-the-reviewed-environment"
      container_app_environment_default_domain = "lemonsmoke-1009414c.northcentralus.azurecontainerapps.io"
      container_apps_outbound_ipv4             = "64.236.176.41"
      postgres_server_resource_id              = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
      postgres_server_fqdn                     = "cosmaneura-prod-postgres.postgres.database.azure.com"
    }
  }

  expect_failures = [
    var.production_existing_hosting_binding,
  ]
}

run "reuse_refuses_a_shared_core_database_name" {
  command = plan

  variables {
    postgres_database_name = "production"
  }

  expect_failures = [
    azurerm_storage_account.audio,
  ]
}

run "reuse_refuses_behavior_activation" {
  command = plan

  variables {
    enable_capture_protocol = true
  }

  expect_failures = [
    azurerm_storage_account.audio,
  ]
}

run "reuse_fatally_refuses_a_mutable_workflow_image" {
  command = plan

  variables {
    container_image_digest = "not-deployed"
  }

  expect_failures = [
    azurerm_storage_account.audio,
  ]
}

run "reuse_fatally_refuses_a_mutable_receiver_image" {
  command = plan

  variables {
    production_native_receiver_image_digest = "not-deployed"
  }

  expect_failures = [
    azurerm_storage_account.audio,
  ]
}

run "reuse_refuses_a_missing_exact_host_binding" {
  command = plan

  variables {
    production_existing_hosting_binding = null
  }

  expect_failures = [
    var.production_existing_hosting_binding,
  ]
}
