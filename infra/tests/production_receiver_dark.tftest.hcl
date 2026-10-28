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

  virtual_network_address_space            = ["10.44.0.0/16"]
  private_endpoint_subnet_address_prefixes = ["10.44.1.0/24"]
  container_apps_subnet_address_prefixes   = ["10.44.2.0/23"]
  postgres_subnet_address_prefixes         = ["10.44.4.0/24"]
}

run "production_receiver_foundation_is_dark" {
  command = plan

  assert {
    condition     = length(azurerm_container_app.api) == 0
    error_message = "production must not deploy the Scribe API until explicitly activated"
  }

  assert {
    condition     = length(azurerm_postgresql_flexible_server.scribe) == 0
    error_message = "production must not create paid PostgreSQL capacity by default"
  }

  assert {
    condition = (
      length(azurerm_container_app_job.database_migrations) == 0 &&
      length(azurerm_container_app_job.transcription) == 0 &&
      length(azurerm_container_app_job.delivery_reconciler) == 0 &&
      length(azurerm_container_app_job.private_api_acceptance) == 0 &&
      length(azurerm_container_app_job.private_terraform_runner) == 0
    )
    error_message = "production must not deploy any Scribe job by default"
  }

  assert {
    condition = (
      length(azurerm_cognitive_account.speech) == 0 &&
      length(azurerm_virtual_network_peering.scribe_to_parallel_platform) == 0 &&
      length(azurerm_private_dns_zone_virtual_network_link.parallel_platform_container_apps) == 0
    )
    error_message = "production must not create Speech or connect to the platform VNet by default"
  }

  assert {
    condition = (
      !var.enable_workflow_authentication &&
      !var.enable_capture_protocol &&
      !var.enable_master_platform_handoff
    )
    error_message = "production workflow auth, capture, and handoff must remain disabled by default"
  }

  assert {
    condition = (
      azurerm_container_app_environment.scribe.internal_load_balancer_enabled &&
      azurerm_container_app_environment.scribe.public_network_access == "Disabled"
    )
    error_message = "the receiver foundation must keep its Container Apps environment private"
  }

  assert {
    condition = (
      !azurerm_storage_account.audio.public_network_access_enabled &&
      !azurerm_storage_account.audio.shared_access_key_enabled &&
      !azurerm_storage_account.audio.local_user_enabled &&
      azurerm_storage_account.audio.default_to_oauth_authentication
    )
    error_message = "production audio storage must remain private and managed-identity only"
  }

  assert {
    condition = (
      !azurerm_key_vault.scribe.public_network_access_enabled &&
      azurerm_key_vault.scribe.rbac_authorization_enabled &&
      azurerm_key_vault.scribe.purge_protection_enabled
    )
    error_message = "production Key Vault must remain private, RBAC-only, and purge protected"
  }
}

run "production_api_refuses_process_memory" {
  command = plan

  variables {
    deploy_container_app = true
    container_image_tag  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [
    azurerm_container_app.api,
  ]
}

run "capture_refuses_missing_auth_and_postgres" {
  command = plan

  variables {
    enable_capture_protocol = true
  }

  expect_failures = [
    var.enable_capture_protocol,
  ]
}
