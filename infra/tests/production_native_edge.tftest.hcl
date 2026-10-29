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
      client_id    = "10000000-0000-4000-8000-000000000003"
      principal_id = "10000000-0000-4000-8000-000000000004"
    }
  }

  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.App/managedEnvironments/cosmaneura-scribe-prod-environment"
      default_domain    = "synthetic-production.azurecontainerapps.io"
      static_ip_address = "203.0.113.10"
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
  target = azurerm_container_app_environment.scribe
  values = {
    id                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.App/managedEnvironments/cosmaneura-scribe-prod-private-environment"
    default_domain    = "synthetic-private.azurecontainerapps.io"
    static_ip_address = "10.44.2.4"
  }
}

override_resource {
  target = azurerm_container_app_environment.production_native_edge
  values = {
    id                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.App/managedEnvironments/cosmaneura-scribe-prod-native-edge-environment"
    default_domain    = "synthetic-production.azurecontainerapps.io"
    static_ip_address = "203.0.113.10"
  }
}

override_resource {
  target = azurerm_container_app.api
  values = {
    ingress = {
      fqdn = "cosmaneura-scribe-prod-api.synthetic-production.azurecontainerapps.io"
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

  virtual_network_address_space                  = ["10.44.0.0/16"]
  private_endpoint_subnet_address_prefixes       = ["10.44.1.0/24"]
  container_apps_subnet_address_prefixes         = ["10.44.2.0/23"]
  postgres_subnet_address_prefixes               = ["10.44.4.0/24"]
  production_native_edge_subnet_address_prefixes = ["10.44.6.0/23"]

  deploy_production_native_edge  = true
  deploy_container_app           = true
  deploy_postgres_foundation     = true
  deploy_database_migration_job  = true
  use_postgres_repository        = true
  enable_workflow_authentication = true
  workflow_api_audience          = "10000000-0000-4000-8000-000000000001"
  trusted_platform_client_id     = "10000000-0000-4000-8000-000000000002"
  container_image_tag            = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  container_image_digest         = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  production_native_receiver_image_tag             = "cccccccccccccccccccccccccccccccccccccccc"
  production_native_receiver_image_digest          = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  production_native_receiver_image_contract_sha256 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  production_native_receiver_identity_resource_id  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-prod-scribe-workflow"
  production_native_receiver_identity_client_id    = "10000000-0000-4000-8000-000000000003"
  production_core_registry_postgres_resource_id    = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
  production_native_receiver_binding = {
    environment_id                = "30000000-0000-4000-8000-000000000001"
    beta_box_id                   = "30000000-0000-4000-8000-000000000002"
    core_registry_database_host   = "cosmaneura-prod-postgres.postgres.database.azure.com"
    core_registry_database_name   = "cosmaneura"
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

run "edge_is_deployable_but_behaviorally_dark" {
  command = plan

  assert {
    condition = (
      azurerm_container_app_environment.scribe.internal_load_balancer_enabled &&
      azurerm_container_app_environment.scribe.public_network_access == "Disabled" &&
      length(azurerm_container_app_environment.production_native_edge) == 1 &&
      !azurerm_container_app_environment.production_native_edge[0].internal_load_balancer_enabled &&
      azurerm_container_app_environment.production_native_edge[0].public_network_access == "Enabled" &&
      length(azurerm_subnet.production_native_edge) == 1 &&
      toset(azurerm_subnet.production_native_edge[0].address_prefixes) == toset(var.production_native_edge_subnet_address_prefixes) &&
      length(azurerm_network_security_group.production_native_edge) == 1 &&
      length(azurerm_subnet_network_security_group_association.production_native_edge) == 1 &&
      !contains([
        for rule in azurerm_network_security_group.container_apps.security_rule : rule.name
      ], "AllowProductionHttpsInbound")
    )
    error_message = "the existing private environment must remain unchanged while a dedicated external VNet-injected environment serves production callers"
  }

  assert {
    condition = (
      azurerm_container_app.api[0].ingress[0].external_enabled &&
      azurerm_container_app.api[0].container_app_environment_id == azurerm_container_app_environment.production_native_edge[0].id &&
      azurerm_container_app.api[0].template[0].min_replicas == 1 &&
      azurerm_container_app.api[0].template[0].container[0].image == "cosmaneurascribeprod.azurecr.io/cosmaneura-scribe-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" &&
      {
        for value in azurerm_container_app.api[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_WORKFLOW_AUTHENTICATION_ENABLED"] == "true" &&
      {
        for value in azurerm_container_app.api[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_WORKFLOW_API_AUDIENCE"] == var.workflow_api_audience &&
      {
        for value in azurerm_container_app.api[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_TRUSTED_PLATFORM_CLIENT_ID"] == var.trusted_platform_client_id
    )
    error_message = "the public workflow API must stay warm, use the immutable image, and retain exact Entra authentication"
  }

  assert {
    condition = (
      output.production_workflow_api_origin == "https://cosmaneura-scribe-prod-api.synthetic-production.azurecontainerapps.io" &&
      output.production_workflow_api_origin == "https://${azurerm_container_app.api[0].ingress[0].fqdn}" &&
      !strcontains(output.production_workflow_api_origin, ".internal.")
    )
    error_message = "the dedicated edge must continue exporting Azure's actual public workflow API ingress FQDN"
  }

  assert {
    condition = (
      azurerm_container_app_job.database_migrations[0].container_app_environment_id == azurerm_container_app_environment.scribe.id &&
      azurerm_container_app_job.database_migrations[0].container_app_environment_id != azurerm_container_app_environment.production_native_edge[0].id &&
      azurerm_container_app_job.database_migrations[0].resource_group_name == local.resource_group_name &&
      azurerm_container_app_job.database_migrations[0].location == local.resource_group_location
    )
    error_message = "the dedicated-edge migration job must remain in the original private Scribe environment"
  }

  assert {
    condition = (
      length(azurerm_container_app.production_native_receiver) == 1 &&
      azurerm_container_app.production_native_receiver[0].ingress[0].external_enabled &&
      azurerm_container_app.production_native_receiver[0].container_app_environment_id == azurerm_container_app_environment.production_native_edge[0].id &&
      azurerm_container_app.production_native_receiver[0].template[0].min_replicas == 0 &&
      azurerm_container_app.production_native_receiver[0].template[0].container[0].image == "cosmaneurascribeprod.azurecr.io/cosmaneura-scribe-native-receiver@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    )
    error_message = "the standalone receiver must exist at its immutable digest but remain scaled to zero"
  }

  assert {
    condition = (
      jsondecode(nonsensitive({
        for value in azurerm_container_app.production_native_receiver[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"])).enabled == false &&
      jsondecode(nonsensitive({
        for value in azurerm_container_app.production_native_receiver[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"])).encounter_creation_enabled == false &&
      jsondecode(nonsensitive({
        for value in azurerm_container_app.production_native_receiver[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"])).production.core_origin == "https://app.cosmaneura.com" &&
      jsondecode(nonsensitive({
        for value in azurerm_container_app.production_native_receiver[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"])).production.issuer == "https://clerk.cosmaneura.com" &&
      jsondecode(nonsensitive({
        for value in azurerm_container_app.production_native_receiver[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"])).production.receiver_origin == "https://cosmaneura-scribe-prod-native.synthetic-production.azurecontainerapps.io"
    )
    error_message = "the dark receiver must disable behavior and bind the exact production Core, Clerk, and receiver origins"
  }

  assert {
    condition = (
      !azurerm_storage_account.audio.public_network_access_enabled &&
      !azurerm_storage_account.audio.shared_access_key_enabled &&
      !azurerm_storage_account.audio.local_user_enabled &&
      !azurerm_storage_account.audio.allow_nested_items_to_be_public &&
      azurerm_storage_container.audio.container_access_type == "private"
    )
    error_message = "encrypted direct upload must remain closed until its independent gate is enabled"
  }

  assert {
    condition = (
      length(azurerm_private_endpoint.core_registry_postgres) == 1 &&
      azurerm_private_endpoint.core_registry_postgres[0].private_service_connection[0].private_connection_resource_id == var.production_core_registry_postgres_resource_id &&
      !azurerm_key_vault.scribe.public_network_access_enabled &&
      !azurerm_postgresql_flexible_server.scribe[0].public_network_access_enabled
    )
    error_message = "both databases and Key Vault must remain private"
  }

  assert {
    condition = (
      contains([
        for rule in azurerm_network_security_group.production_native_edge[0].security_rule : rule.name
      ], "AllowProductionHttpsInbound") &&
      contains([
        for rule in azurerm_network_security_group.production_native_edge[0].security_rule : rule.name
      ], "AllowProductionHttpsOutbound") &&
      contains([
        for rule in azurerm_network_security_group.production_native_edge[0].security_rule : rule.name
      ], "AllowCoreRegistryPostgresOutbound") &&
      contains([
        for rule in azurerm_network_security_group.private_endpoints.security_rule : rule.name
      ], "AllowContainerAppsPostgresInbound")
    )
    error_message = "the external apps and private Core registry route must be reachable through the otherwise deny-all NSGs"
  }
}

run "encrypted_native_upload_opens_without_weakening_authentication" {
  command = plan

  variables {
    enable_capture_protocol                        = true
    enable_production_native_direct_upload         = true
    production_native_upload_policy_receipt_sha256 = "5555555555555555555555555555555555555555555555555555555555555555"
  }

  assert {
    condition = (
      azurerm_storage_account.audio.public_network_access_enabled &&
      !azurerm_storage_account.audio.shared_access_key_enabled &&
      !azurerm_storage_account.audio.local_user_enabled &&
      !azurerm_storage_account.audio.allow_nested_items_to_be_public &&
      azurerm_storage_account.audio.default_to_oauth_authentication &&
      azurerm_storage_container.audio.container_access_type == "private"
    )
    error_message = "public Blob routing must not enable shared keys, local users, or anonymous data"
  }

  assert {
    condition = (
      length(azurerm_storage_account.audio.blob_properties[0].cors_rule) == 1 &&
      toset(azurerm_storage_account.audio.blob_properties[0].cors_rule[0].allowed_methods) == toset(["OPTIONS", "PUT"]) &&
      toset(azurerm_storage_account.audio.blob_properties[0].cors_rule[0].allowed_origins) == toset(["app://cosmas", "capacitor://localhost"]) &&
      toset(azurerm_storage_account.audio.blob_properties[0].cors_rule[0].allowed_headers) == toset(["content-type", "x-ms-blob-type"])
    )
    error_message = "the upload CORS policy must name only the two native origins and complete-envelope PUT headers"
  }
}

run "receiver_activation_requires_and_preserves_all_gates" {
  command = plan

  variables {
    enable_capture_protocol                        = true
    enable_production_native_direct_upload         = true
    production_native_upload_policy_receipt_sha256 = "5555555555555555555555555555555555555555555555555555555555555555"
    enable_production_native_receiver              = true
    enable_production_native_encounter_creation    = true
  }

  assert {
    condition = (
      azurerm_container_app.production_native_receiver[0].template[0].min_replicas == 1 &&
      jsondecode(nonsensitive({
        for value in azurerm_container_app.production_native_receiver[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"])).enabled == true &&
      jsondecode(nonsensitive({
        for value in azurerm_container_app.production_native_receiver[0].template[0].container[0].env :
        value.name => value.value
      }["COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"])).encounter_creation_enabled == true
    )
    error_message = "the receiver and encounter gates must control runtime configuration and minimum scale together"
  }
}

run "direct_upload_refuses_missing_policy_receipt" {
  command = plan

  variables {
    enable_production_native_direct_upload = true
  }

  expect_failures = [
    var.enable_production_native_direct_upload,
  ]
}

run "receiver_refuses_closed_capture_and_upload_gates" {
  command = plan

  variables {
    enable_production_native_receiver = true
  }

  expect_failures = [
    var.enable_production_native_receiver,
  ]
}

run "encounter_creation_refuses_disabled_receiver" {
  command = plan

  variables {
    enable_production_native_encounter_creation = true
  }

  expect_failures = [
    var.enable_production_native_encounter_creation,
  ]
}

run "edge_refuses_nonproduction_environment" {
  command = plan

  variables {
    environment = "staging"
  }

  expect_failures = [
    var.deploy_production_native_edge,
  ]
}

run "edge_refuses_mutable_workflow_image" {
  command = plan

  variables {
    container_image_digest = "not-deployed"
  }

  expect_failures = [
    var.deploy_production_native_edge,
  ]
}

run "edge_refuses_missing_exact_receiver_binding" {
  command = plan

  variables {
    production_native_receiver_binding = null
  }

  expect_failures = [
    var.production_native_receiver_binding,
  ]
}

run "edge_refuses_mutable_receiver_image" {
  command = plan

  variables {
    production_native_receiver_image_digest = "not-deployed"
  }

  expect_failures = [
    var.deploy_production_native_edge,
  ]
}

run "edge_refuses_shared_existing_subnet" {
  command = plan

  variables {
    production_native_edge_subnet_address_prefixes = ["10.44.2.0/23"]
  }

  expect_failures = [
    var.production_native_edge_subnet_address_prefixes,
  ]
}


run "edge_refuses_undersized_subnet" {
  command = plan

  variables {
    production_native_edge_subnet_address_prefixes = ["10.44.6.0/24"]
  }

  expect_failures = [
    var.production_native_edge_subnet_address_prefixes,
  ]
}
