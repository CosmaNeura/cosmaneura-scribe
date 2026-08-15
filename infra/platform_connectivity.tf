# Scribe owns resources created inside its network boundary. The platform repository owns the
# opposite peering object and supplies only its non-secret VNet resource ID. Both resources are
# false-by-default and must be reviewed with the platform foundation before either apply.
resource "azurerm_virtual_network_peering" "scribe_to_parallel_platform" {
  count = var.connect_parallel_platform_vnet ? 1 : 0

  name                         = "scribe-to-platform"
  resource_group_name          = local.resource_group_name
  virtual_network_name         = azurerm_virtual_network.scribe.name
  remote_virtual_network_id    = var.parallel_platform_vnet_id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = false
  allow_gateway_transit        = false
  use_remote_gateways          = false

  lifecycle {
    precondition {
      condition     = var.parallel_platform_vnet_id != ""
      error_message = "parallel_platform_vnet_id is required when connect_parallel_platform_vnet is true"
    }
  }
}

resource "azurerm_private_dns_zone_virtual_network_link" "parallel_platform_container_apps" {
  count = var.connect_parallel_platform_vnet ? 1 : 0

  name                  = "${local.name_prefix}-platform-container-apps-link"
  resource_group_name   = local.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.container_apps.name
  virtual_network_id    = var.parallel_platform_vnet_id
  registration_enabled  = false
  tags                  = local.tags

  lifecycle {
    precondition {
      condition     = var.parallel_platform_vnet_id != ""
      error_message = "parallel_platform_vnet_id is required when connect_parallel_platform_vnet is true"
    }
  }
}
