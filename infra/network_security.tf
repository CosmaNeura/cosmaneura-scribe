resource "azurerm_network_security_group" "private_endpoints" {
  name                = "${local.name_prefix}-private-endpoints-nsg"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

  security_rule {
    name                       = "AllowVnetHttpsInbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
  }

  dynamic "security_rule" {
    for_each = local.production_private_data_paths ? [1] : []

    content {
      name                         = "AllowContainerAppsPostgresInbound"
      priority                     = 110
      direction                    = "Inbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_port_range            = "*"
      destination_port_range       = "5432"
      source_address_prefixes      = concat(var.deploy_production_native_edge ? var.production_native_edge_subnet_address_prefixes : [], var.deploy_production_captured_workers ? var.container_apps_subnet_address_prefixes : [])
      destination_address_prefixes = var.private_endpoint_subnet_address_prefixes
    }
  }

  security_rule {
    name                       = "DenyAllInbound"
    priority                   = 4095
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "DenyAllOutbound"
    priority                   = 4096
    direction                  = "Outbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  tags = local.tags
}

resource "azurerm_subnet_network_security_group_association" "private_endpoints" {
  subnet_id                 = azurerm_subnet.private_endpoints.id
  network_security_group_id = azurerm_network_security_group.private_endpoints.id
}

resource "azurerm_network_security_group" "container_apps" {
  name                = "${local.name_prefix}-container-apps-nsg"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

  security_rule {
    name                         = "AllowContainerSubnetInbound"
    priority                     = 100
    direction                    = "Inbound"
    access                       = "Allow"
    protocol                     = "*"
    source_port_range            = "*"
    destination_port_range       = "*"
    source_address_prefixes      = var.container_apps_subnet_address_prefixes
    destination_address_prefixes = var.container_apps_subnet_address_prefixes
  }

  security_rule {
    name                       = "AllowVnetHttpsInbound"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["443", "31443"]
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "AllowAzureLoadBalancerProbesInbound"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "30000-32767"
    source_address_prefix      = "AzureLoadBalancer"
    destination_address_prefix = "*"
  }

  security_rule {
    name                         = "AllowContainerSubnetOutbound"
    priority                     = 200
    direction                    = "Outbound"
    access                       = "Allow"
    protocol                     = "*"
    source_port_range            = "*"
    destination_port_range       = "*"
    source_address_prefixes      = var.container_apps_subnet_address_prefixes
    destination_address_prefixes = var.container_apps_subnet_address_prefixes
  }

  security_rule {
    name                       = "AllowMicrosoftContainerRegistryOutbound"
    priority                   = 210
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "MicrosoftContainerRegistry"
  }

  security_rule {
    name                       = "AllowAzureFrontDoorFirstPartyOutbound"
    priority                   = 220
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "AzureFrontDoor.FirstParty"
  }

  security_rule {
    name                       = "AllowAzureActiveDirectoryOutbound"
    priority                   = 230
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "AzureActiveDirectory"
  }

  security_rule {
    name                       = "AllowAzureMonitorOutbound"
    priority                   = 240
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "AzureMonitor"
  }

  security_rule {
    name                       = "AllowAzureContainerRegistryOutbound"
    priority                   = 250
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "AzureContainerRegistry"
  }

  dynamic "security_rule" {
    for_each = var.enable_private_terraform_runner ? [1] : []

    content {
      name                       = "AllowTemporaryTerraformArmOutbound"
      priority                   = 255
      direction                  = "Outbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "443"
      source_address_prefix      = "*"
      destination_address_prefix = "AzureResourceManager"
    }
  }

  security_rule {
    name                       = "AllowEastUsStorageOutbound"
    priority                   = 260
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "Storage.EastUS"
  }

  dynamic "security_rule" {
    for_each = var.enable_private_terraform_runner ? [1] : []

    content {
      name                       = "AllowTemporaryTerraformStateOutbound"
      priority                   = 265
      direction                  = "Outbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "443"
      source_address_prefix      = "*"
      destination_address_prefix = "Storage.NorthCentralUS"
    }
  }

  security_rule {
    name                       = "AllowAzureDnsOutbound"
    priority                   = 270
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "53"
    source_address_prefix      = "*"
    destination_address_prefix = "168.63.129.16"
  }

  security_rule {
    name                       = "AllowVnetHttpsOutbound"
    priority                   = 280
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "VirtualNetwork"
  }

  security_rule {
    name                         = "AllowPostgresOutbound"
    priority                     = 290
    direction                    = "Outbound"
    access                       = "Allow"
    protocol                     = "Tcp"
    source_port_range            = "*"
    destination_port_range       = "5432"
    source_address_prefix        = "*"
    destination_address_prefixes = var.postgres_subnet_address_prefixes
  }

  dynamic "security_rule" {
    for_each = var.deploy_production_captured_workers ? [1] : []
    content {
      name                         = "AllowCapturedPrivateCorePostgresOutbound"
      priority                     = 295
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_port_range            = "*"
      destination_port_range       = "5432"
      source_address_prefixes      = var.container_apps_subnet_address_prefixes
      destination_address_prefixes = var.private_endpoint_subnet_address_prefixes
    }
  }

  security_rule {
    name                       = "DenyAllInbound"
    priority                   = 4095
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "DenyAllOutbound"
    priority                   = 4096
    direction                  = "Outbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  tags = local.tags
}

resource "azurerm_subnet_network_security_group_association" "container_apps" {
  subnet_id                 = azurerm_subnet.container_apps.id
  network_security_group_id = azurerm_network_security_group.container_apps.id
}

locals {
  production_native_edge_security_rules = {
    AllowEdgeSubnetInbound = {
      priority                     = 100
      direction                    = "Inbound"
      access                       = "Allow"
      protocol                     = "*"
      source_address_prefix        = null
      source_address_prefixes      = var.production_native_edge_subnet_address_prefixes
      destination_address_prefix   = null
      destination_address_prefixes = var.production_native_edge_subnet_address_prefixes
      destination_port_range       = "*"
      destination_port_ranges      = null
    }
    AllowVnetHttpsInbound = {
      priority                     = 110
      direction                    = "Inbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "VirtualNetwork"
      source_address_prefixes      = null
      destination_address_prefix   = "*"
      destination_address_prefixes = null
      destination_port_range       = null
      destination_port_ranges      = ["443", "31443"]
    }
    AllowProductionHttpsInbound = {
      priority                     = 115
      direction                    = "Inbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "Internet"
      source_address_prefixes      = null
      destination_address_prefix   = "*"
      destination_address_prefixes = null
      destination_port_range       = null
      destination_port_ranges      = ["443", "31443"]
    }
    AllowAzureLoadBalancerProbesInbound = {
      priority                     = 120
      direction                    = "Inbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "AzureLoadBalancer"
      source_address_prefixes      = null
      destination_address_prefix   = "*"
      destination_address_prefixes = null
      destination_port_range       = "30000-32767"
      destination_port_ranges      = null
    }
    AllowEdgeSubnetOutbound = {
      priority                     = 200
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "*"
      source_address_prefix        = null
      source_address_prefixes      = var.production_native_edge_subnet_address_prefixes
      destination_address_prefix   = null
      destination_address_prefixes = var.production_native_edge_subnet_address_prefixes
      destination_port_range       = "*"
      destination_port_ranges      = null
    }
    AllowMicrosoftContainerRegistryOutbound = {
      priority                     = 210
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "MicrosoftContainerRegistry"
      destination_address_prefixes = null
      destination_port_range       = "443"
      destination_port_ranges      = null
    }
    AllowAzureFrontDoorFirstPartyOutbound = {
      priority                     = 220
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "AzureFrontDoor.FirstParty"
      destination_address_prefixes = null
      destination_port_range       = "443"
      destination_port_ranges      = null
    }
    AllowAzureActiveDirectoryOutbound = {
      priority                     = 230
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "AzureActiveDirectory"
      destination_address_prefixes = null
      destination_port_range       = "443"
      destination_port_ranges      = null
    }
    AllowAzureMonitorOutbound = {
      priority                     = 240
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "AzureMonitor"
      destination_address_prefixes = null
      destination_port_range       = "443"
      destination_port_ranges      = null
    }
    AllowAzureContainerRegistryOutbound = {
      priority                     = 250
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "AzureContainerRegistry"
      destination_address_prefixes = null
      destination_port_range       = "443"
      destination_port_ranges      = null
    }
    AllowEastUsStorageOutbound = {
      priority                     = 260
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "Storage.EastUS"
      destination_address_prefixes = null
      destination_port_range       = "443"
      destination_port_ranges      = null
    }
    AllowAzureDnsOutbound = {
      priority                     = 270
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "*"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "168.63.129.16"
      destination_address_prefixes = null
      destination_port_range       = "53"
      destination_port_ranges      = null
    }
    AllowProductionHttpsOutbound = {
      priority                     = 275
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "Internet"
      destination_address_prefixes = null
      destination_port_range       = "443"
      destination_port_ranges      = null
    }
    AllowVnetHttpsOutbound = {
      priority                     = 280
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "VirtualNetwork"
      destination_address_prefixes = null
      destination_port_range       = "443"
      destination_port_ranges      = null
    }
    AllowCoreRegistryPostgresOutbound = {
      priority                     = 285
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = null
      destination_address_prefixes = var.private_endpoint_subnet_address_prefixes
      destination_port_range       = "5432"
      destination_port_ranges      = null
    }
    AllowScribePostgresOutbound = {
      priority                     = 290
      direction                    = "Outbound"
      access                       = "Allow"
      protocol                     = "Tcp"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = null
      destination_address_prefixes = var.postgres_subnet_address_prefixes
      destination_port_range       = "5432"
      destination_port_ranges      = null
    }
    DenyAllInbound = {
      priority                     = 4095
      direction                    = "Inbound"
      access                       = "Deny"
      protocol                     = "*"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "*"
      destination_address_prefixes = null
      destination_port_range       = "*"
      destination_port_ranges      = null
    }
    DenyAllOutbound = {
      priority                     = 4096
      direction                    = "Outbound"
      access                       = "Deny"
      protocol                     = "*"
      source_address_prefix        = "*"
      source_address_prefixes      = null
      destination_address_prefix   = "*"
      destination_address_prefixes = null
      destination_port_range       = "*"
      destination_port_ranges      = null
    }
  }
}

resource "azurerm_network_security_group" "production_native_edge" {
  count = var.deploy_production_native_edge ? 1 : 0

  name                = "${local.name_prefix}-native-edge-nsg"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

  dynamic "security_rule" {
    for_each = local.production_native_edge_security_rules

    content {
      name                         = security_rule.key
      priority                     = security_rule.value.priority
      direction                    = security_rule.value.direction
      access                       = security_rule.value.access
      protocol                     = security_rule.value.protocol
      source_port_range            = "*"
      destination_port_range       = security_rule.value.destination_port_range
      destination_port_ranges      = security_rule.value.destination_port_ranges
      source_address_prefix        = security_rule.value.source_address_prefix
      source_address_prefixes      = security_rule.value.source_address_prefixes
      destination_address_prefix   = security_rule.value.destination_address_prefix
      destination_address_prefixes = security_rule.value.destination_address_prefixes
    }
  }

  tags = local.tags
}

resource "azurerm_subnet_network_security_group_association" "production_native_edge" {
  count = var.deploy_production_native_edge ? 1 : 0

  subnet_id                 = azurerm_subnet.production_native_edge[0].id
  network_security_group_id = azurerm_network_security_group.production_native_edge[0].id
}
