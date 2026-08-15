resource "azurerm_virtual_network" "scribe" {
  name                = "${local.name_prefix}-vnet"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  address_space       = var.virtual_network_address_space
  tags                = local.tags
}

resource "azurerm_subnet" "private_endpoints" {
  name                 = "private-endpoints"
  resource_group_name  = local.resource_group_name
  virtual_network_name = azurerm_virtual_network.scribe.name
  address_prefixes     = var.private_endpoint_subnet_address_prefixes

  private_endpoint_network_policies = "NetworkSecurityGroupEnabled"
}

resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  name                  = "${local.name_prefix}-blob-link"
  resource_group_name   = local.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.blob.name
  virtual_network_id    = azurerm_virtual_network.scribe.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_dns_zone" "key_vault" {
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "key_vault" {
  name                  = "${local.name_prefix}-vault-link"
  resource_group_name   = local.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.key_vault.name
  virtual_network_id    = azurerm_virtual_network.scribe.id
  registration_enabled  = false
  tags                  = local.tags
}
