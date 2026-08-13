locals {
  name_prefix = "cosmaneura-scribe-${var.environment}"
  resource_group_name = var.create_resource_group ? (
    azurerm_resource_group.scribe[0].name
  ) : data.azurerm_resource_group.scribe[0].name
  resource_group_location = var.create_resource_group ? (
    azurerm_resource_group.scribe[0].location
  ) : data.azurerm_resource_group.scribe[0].location
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
  name                  = "audio"
  storage_account_id    = azurerm_storage_account.audio.id
  container_access_type = "private"
}

resource "azurerm_key_vault" "scribe" {
  name                = var.key_vault_name
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  tenant_id           = var.tenant_id

  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  public_network_access_enabled = false
  soft_delete_retention_days    = 90

  tags = local.tags
}

resource "azurerm_private_endpoint" "audio_blob" {
  name                = "${local.name_prefix}-blob-pe"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  subnet_id           = var.private_endpoint_subnet_id

  private_service_connection {
    name                           = "${local.name_prefix}-blob-connection"
    private_connection_resource_id = azurerm_storage_account.audio.id
    is_manual_connection           = false
    subresource_names              = ["blob"]
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [var.blob_private_dns_zone_id]
  }

  tags = local.tags
}

resource "azurerm_private_endpoint" "key_vault" {
  name                = "${local.name_prefix}-vault-pe"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  subnet_id           = var.private_endpoint_subnet_id

  private_service_connection {
    name                           = "${local.name_prefix}-vault-connection"
    private_connection_resource_id = azurerm_key_vault.scribe.id
    is_manual_connection           = false
    subresource_names              = ["vault"]
  }

  private_dns_zone_group {
    name                 = "vault"
    private_dns_zone_ids = [var.key_vault_private_dns_zone_id]
  }

  tags = local.tags
}

resource "azurerm_role_assignment" "runtime_audio" {
  scope                = azurerm_storage_account.audio.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
}

resource "azurerm_role_assignment" "runtime_vault" {
  scope                = azurerm_key_vault.scribe.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
}
