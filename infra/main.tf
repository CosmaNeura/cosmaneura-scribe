locals {
  name_prefix = "cosmaneura-scribe-${var.environment}"
  environment_short = {
    development = "dev"
    staging     = "stg"
    production  = "prod"
  }[var.environment]
  container_app_name   = "cosmaneura-scribe-${local.environment_short}-api"
  audio_container_name = "audio"
  speech_account_name  = "cosmaneura-scribe-${local.environment_short}-speech"
  resource_group_name = var.create_resource_group ? (
    azurerm_resource_group.scribe[0].name
  ) : data.azurerm_resource_group.scribe[0].name
  resource_group_location = var.create_resource_group ? (
    azurerm_resource_group.scribe[0].location
  ) : data.azurerm_resource_group.scribe[0].location
  resource_group_id = var.create_resource_group ? (
    azurerm_resource_group.scribe[0].id
  ) : data.azurerm_resource_group.scribe[0].id
  tags = merge(var.tags, {
    environment = var.environment
  })
}

resource "azurerm_resource_group" "scribe" {
  count = var.create_resource_group ? 1 : 0

  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

data "azurerm_resource_group" "scribe" {
  count = var.create_resource_group ? 0 : 1

  name = var.resource_group_name
}

resource "azurerm_user_assigned_identity" "runtime" {
  name                = "${local.name_prefix}-runtime"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  tags                = local.tags
}

resource "azurerm_storage_account" "audio" {
  name                = var.storage_account_name
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

  account_tier                      = "Standard"
  account_replication_type          = "ZRS"
  account_kind                      = "StorageV2"
  access_tier                       = "Hot"
  allow_nested_items_to_be_public   = false
  default_to_oauth_authentication   = true
  https_traffic_only_enabled        = true
  infrastructure_encryption_enabled = true
  local_user_enabled                = false
  min_tls_version                   = "TLS1_2"
  public_network_access_enabled     = false
  shared_access_key_enabled         = false

  blob_properties {
    versioning_enabled = true

    container_delete_retention_policy {
      days = 7
    }

    delete_retention_policy {
      days = 7
    }
  }

  tags = local.tags
}

resource "azurerm_storage_container" "audio" {
  name                  = local.audio_container_name
  storage_account_id    = azurerm_storage_account.audio.id
  container_access_type = "private"
}

resource "azurerm_key_vault" "scribe" {
  name                = var.key_vault_name
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  tenant_id           = sensitive(var.tenant_id)

  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  public_network_access_enabled = false
  soft_delete_retention_days    = 90

  tags = local.tags
}

resource "azurerm_key_vault_key" "audio" {
  name         = "session-audio-wrapping"
  key_vault_id = azurerm_key_vault.scribe.id
  key_type     = "RSA"
  key_size     = 3072
  key_opts     = ["unwrapKey", "wrapKey"]

  depends_on = [
    azurerm_private_dns_zone_virtual_network_link.key_vault,
    azurerm_private_endpoint.key_vault,
  ]

  lifecycle {
    prevent_destroy = true
  }

  tags = local.tags
}

resource "azurerm_private_endpoint" "audio_blob" {
  name                = "${local.name_prefix}-blob-pe"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  subnet_id           = azurerm_subnet.private_endpoints.id

  private_service_connection {
    name                           = "${local.name_prefix}-blob-connection"
    private_connection_resource_id = azurerm_storage_account.audio.id
    is_manual_connection           = false
    subresource_names              = ["blob"]
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }

  depends_on = [
    azurerm_subnet_network_security_group_association.private_endpoints,
  ]

  tags = local.tags
}

resource "azurerm_private_endpoint" "key_vault" {
  name                = "${local.name_prefix}-vault-pe"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  subnet_id           = azurerm_subnet.private_endpoints.id

  private_service_connection {
    name                           = "${local.name_prefix}-vault-connection"
    private_connection_resource_id = azurerm_key_vault.scribe.id
    is_manual_connection           = false
    subresource_names              = ["vault"]
  }

  private_dns_zone_group {
    name                 = "vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.key_vault.id]
  }

  depends_on = [
    azurerm_subnet_network_security_group_association.private_endpoints,
  ]

  tags = local.tags
}

resource "azurerm_role_assignment" "runtime_audio" {
  scope                = azurerm_storage_account.audio.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
}

resource "azurerm_role_assignment" "runtime_audio_key_reader" {
  scope                            = azurerm_key_vault_key.audio.resource_id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/21090545-7ca7-4776-b22c-e363652d74d2"
  principal_id                     = azurerm_user_assigned_identity.runtime.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}
