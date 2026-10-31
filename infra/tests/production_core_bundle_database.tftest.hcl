# Secretless provider mocks only: no backend, cloud, state or live plan/apply.
# Known non-secret source selectors exercise exact binding; no capture data.
mock_provider "azapi" {}

mock_provider "azurerm" {
  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.DBforPostgreSQL/flexibleServers/synthetic-scribe-server"
      fqdn = "synthetic-scribe-server.postgres.database.azure.com"
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
  subscription_id         = "bab2a709-1fcb-4c87-a9fc-802f7477ec13"
  tenant_id               = "00000000-0000-4000-8000-000000000001"
  environment             = "production"
  resource_group_name     = "cosmaneura-scribe-production"
  storage_account_name    = "cosmaneurascribeprod"
  key_vault_name          = "cosmaneura-scribe-prod"
  container_registry_name = "cosmaneurascribeprod"
}

run "false_default_adds_no_database_or_workload" {
  command = plan

  assert {
    condition     = !var.prepare_production_core_bundle_database && length(azurerm_postgresql_flexible_server_database.scribe) == 0 && length(azurerm_user_assigned_identity.database_migrations) == 0 && length(azurerm_role_assignment.database_migrations_acr) == 0 && length(azurerm_container_app_job.database_migrations) == 0
    error_message = "The false default must add no database, migration identity, registry grant or job"
  }
}

run "selected_leaf_is_one_isolated_database_on_closed_existing_server" {
  command = plan
  variables { prepare_production_core_bundle_database = true }

  assert {
    condition     = length(azurerm_postgresql_flexible_server_database.scribe) == 1 && azurerm_postgresql_flexible_server_database.scribe[0].name == "cosmaneura_scribe" && azurerm_postgresql_flexible_server_database.scribe[0].server_id == "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres" && azurerm_postgresql_flexible_server_database.scribe[0].charset == "UTF8" && azurerm_postgresql_flexible_server_database.scribe[0].collation == "en_US.utf8" && output.postgres_database_name == "cosmaneura_scribe" && output.postgres_fqdn == "cosmaneura-prod-postgres.postgres.database.azure.com"
    error_message = "Only the isolated logical database on the exact existing server is selected"
  }
  assert {
    condition     = !local.production_database_enabled && length(azurerm_postgresql_flexible_server.scribe) == 0 && length(azurerm_postgresql_flexible_server_active_directory_administrator.migrations) == 0 && length(azurerm_subnet.postgres) == 0 && length(azurerm_private_dns_zone.postgres) == 0 && length(azurerm_user_assigned_identity.database_migrations) == 0 && length(azurerm_role_assignment.database_migrations_acr) == 0 && length(azurerm_container_app_job.database_migrations) == 0 && length(azurerm_container_app.api) == 0 && length(azurerm_container_app.production_native_receiver) == 0 && length(azurerm_container_app_job.production_captured) == 0 && length(azurerm_user_assigned_identity.production_captured) == 0 && length(azurerm_role_assignment.production_core_bundle_key) == 0 && length(data.azurerm_user_assigned_identity.production_core_bundle_api) == 0
    error_message = "Database preparation must not enable server/auth/network/identity/grant/job/app/worker creation"
  }
}

run "preserve_already_owned_migration_identity_setting" {
  command = plan
  variables {
    prepare_production_core_bundle_database        = true
    prepare_production_database_migration_identity = true
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
  assert {
    condition     = length(azurerm_postgresql_flexible_server_database.scribe) == 1 && !local.production_database_enabled && length(azurerm_user_assigned_identity.database_migrations) == 1 && length(azurerm_role_assignment.database_migrations_acr) == 1 && length(azurerm_container_app_job.database_migrations) == 0 && length(azurerm_postgresql_flexible_server_active_directory_administrator.migrations) == 0
    error_message = "A separately owned identity can remain selected without database preparation changing its existing count or creating an administrator/job"
  }
}

run "reject_shared_core_database_name" {
  command = plan
  variables {
    prepare_production_core_bundle_database = true
    postgres_database_name                  = "production"
  }
  expect_failures = [var.prepare_production_core_bundle_database]
}

run "reject_nonproduction_environment" {
  command = plan
  variables {
    prepare_production_core_bundle_database = true
    environment                             = "staging"
  }
  expect_failures = [var.prepare_production_core_bundle_database]
}

run "reject_another_subscription" {
  command = plan
  variables {
    prepare_production_core_bundle_database = true
    subscription_id                         = "00000000-0000-4000-8000-000000000002"
  }
  expect_failures = [var.prepare_production_core_bundle_database]
}

run "reject_dedicated_server_topology" {
  command = plan
  variables {
    prepare_production_core_bundle_database = true
    deploy_postgres_foundation              = true
  }
  expect_failures = [var.prepare_production_core_bundle_database]
}
