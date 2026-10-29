mock_provider "azapi" {}

mock_provider "azurerm" {
  mock_data "azurerm_resource_group" {
    defaults = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production"
      location = "eastus"
    }
  }

  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.App/managedEnvironments/cosmaneura-scribe-prod-environment"
      default_domain    = "mock.internal.azurecontainerapps.io"
      static_ip_address = "10.44.2.4"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ContainerRegistry/registries/cosmaneurascribeprod"
      login_server = "cosmaneurascribeprod.azurecr.io"
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
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/privateDnsZones/mock.internal"
    }
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-scribe-prod-pg"
      fqdn = "cosmaneura-scribe-prod-pg.postgres.database.azure.com"
    }
  }

  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/virtualNetworks/cosmaneura-scribe-production/subnets/mock"
    }
  }

  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Network/virtualNetworks/cosmaneura-scribe-production"
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
      id             = "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping/00000000000000000000000000000000"
      versionless_id = "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id                    = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.Storage/storageAccounts/cosmaneurascribeprod"
      primary_blob_endpoint = "https://cosmaneurascribeprod.blob.core.windows.net/"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-scribe-production-runtime"
      client_id    = "11111111-1111-1111-1111-111111111111"
      principal_id = "22222222-2222-2222-2222-222222222222"
    }
  }
}

variables {
  subscription_id         = "00000000-0000-0000-0000-000000000000"
  tenant_id               = "00000000-0000-0000-0000-000000000000"
  environment             = "production"
  resource_group_name     = "cosmaneura-scribe-production"
  storage_account_name    = "cosmaneurascribeprod"
  key_vault_name          = "cosmaneura-scribe-prod"
  container_registry_name = "cosmaneurascribeprod"

  production_existing_hosting_binding = {
    resource_group_name                      = "cosmaneura-prod"
    location                                 = "northcentralus"
    container_app_environment_id             = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
    container_app_environment_default_domain = "lemonsmoke-1009414c.northcentralus.azurecontainerapps.io"
    container_apps_outbound_ipv4             = "64.236.176.41"
    postgres_server_resource_id              = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
    postgres_server_fqdn                     = "cosmaneura-prod-postgres.postgres.database.azure.com"
  }

  virtual_network_address_space            = ["10.44.0.0/16"]
  private_endpoint_subnet_address_prefixes = ["10.44.1.0/24"]
  container_apps_subnet_address_prefixes   = ["10.44.2.0/23"]
  postgres_subnet_address_prefixes         = ["10.44.4.0/24"]
}

run "preparation_is_false_by_default" {
  command = plan
  assert {
    condition = (
      !var.prepare_production_database_migration_identity &&
      length(azurerm_user_assigned_identity.database_migrations) == 0 &&
      length(azurerm_role_assignment.database_migrations_acr) == 0
    )
    error_message = "the new prerequisite must create nothing by default"
  }
}

run "preparation_creates_only_the_existing_migration_identity_contract" {
  command = plan
  variables {
    prepare_production_database_migration_identity = true
  }
  assert {
    condition = (
      length(azurerm_user_assigned_identity.database_migrations) == 1 &&
      azurerm_user_assigned_identity.database_migrations[0].name == "cosmaneura-scribe-production-database-migrations" &&
      azurerm_user_assigned_identity.database_migrations[0].resource_group_name == "cosmaneura-scribe-production" &&
      length(azurerm_role_assignment.database_migrations_acr) == 1 &&
      azurerm_role_assignment.database_migrations_acr[0].role_definition_name == "AcrPull" &&
      azurerm_role_assignment.database_migrations_acr[0].scope == azurerm_container_registry.scribe.id &&
      azurerm_role_assignment.database_migrations_acr[0].principal_id == azurerm_user_assigned_identity.database_migrations[0].principal_id
    )
    error_message = "preparation must preserve the exact migration identity and registry-only Pull contract"
  }
  assert {
    condition = (
      !local.production_database_enabled &&
      !local.production_workloads_enabled &&
      length(azurerm_postgresql_flexible_server.scribe) == 0 &&
      length(azurerm_postgresql_flexible_server_database.scribe) == 0 &&
      length(azurerm_postgresql_flexible_server_active_directory_administrator.migrations) == 0 &&
      length(azurerm_container_app.api) == 0 &&
      length(azurerm_container_app.production_native_receiver) == 0 &&
      length(azurerm_container_app_job.database_migrations) == 0 &&
      length(azurerm_container_app_job.production_captured) == 0 &&
      length(azurerm_user_assigned_identity.production_captured) == 0 &&
      length(azurerm_role_assignment.production_captured_ai) == 0 &&
      length(azurerm_role_assignment.production_captured_blob_reader) == 0 &&
      length(azurerm_role_assignment.production_captured_key_crypto_user) == 0 &&
      length(azurerm_container_app_job.transcription) == 0 &&
      length(azurerm_container_app_job.delivery_reconciler) == 0 &&
      length(azurerm_container_app_job.speech_smoke) == 0 &&
      length(azurerm_container_app_job.private_api_acceptance) == 0 &&
      length(azurerm_container_app_job.private_terraform_runner) == 0
    )
    error_message = "identity preparation must not create databases, administrators, jobs, apps, processing identities, or capture permissions"
  }
  assert {
    condition = (
      length(azurerm_subnet.postgres) == 0 &&
      length(azurerm_subnet.production_native_edge) == 0 &&
      length(azurerm_private_endpoint.core_registry_postgres) == 0 &&
      length(azurerm_private_endpoint.production_ai) == 0 &&
      length(azurerm_virtual_network_peering.scribe_to_parallel_platform) == 0 &&
      !azurerm_storage_account.audio.public_network_access_enabled &&
      !azurerm_key_vault.scribe.public_network_access_enabled
    )
    error_message = "identity preparation must preserve the private foundation without new network resources or access"
  }
}

run "preparation_refuses_nonproduction" {
  command = plan
  variables {
    environment                                    = "staging"
    prepare_production_database_migration_identity = true
  }
  expect_failures = [var.prepare_production_database_migration_identity]
}

run "preparation_refuses_a_missing_host_binding" {
  command = plan
  variables {
    prepare_production_database_migration_identity = true
    production_existing_hosting_binding            = null
  }
  expect_failures = [var.production_existing_hosting_binding]
}

run "preparation_refuses_a_different_host" {
  command = plan
  variables {
    prepare_production_database_migration_identity = true
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
  expect_failures = [var.production_existing_hosting_binding]
}

run "preparation_refuses_workload_deployment" {
  command = plan
  variables {
    prepare_production_database_migration_identity = true
    deploy_postgres_foundation                     = true
  }
  expect_failures = [var.prepare_production_database_migration_identity]
}

run "preparation_refuses_authentication_activation" {
  command = plan
  variables {
    prepare_production_database_migration_identity = true
    enable_workflow_authentication                 = true
    workflow_api_audience                          = "33333333-3333-4333-8333-333333333333"
    trusted_platform_client_id                     = "44444444-4444-4444-8444-444444444444"
  }
  expect_failures = [var.prepare_production_database_migration_identity]
}
