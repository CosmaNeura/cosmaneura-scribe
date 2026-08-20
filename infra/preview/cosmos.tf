resource "azurerm_cosmosdb_account" "preview" {
  name                = local.cosmos_account_name
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  access_key_metadata_writes_enabled    = false
  automatic_failover_enabled            = false
  free_tier_enabled                     = false
  local_authentication_enabled          = false
  minimal_tls_version                   = "Tls12"
  multiple_write_locations_enabled      = false
  network_acl_bypass_for_azure_services = false
  public_network_access_enabled         = true

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = azurerm_resource_group.preview.location
    failover_priority = 0
    zone_redundant    = false
  }

  tags = local.tags
}

resource "azurerm_cosmosdb_sql_database" "preview" {
  name                = var.cosmos_database_name
  resource_group_name = azurerm_resource_group.preview.name
  account_name        = azurerm_cosmosdb_account.preview.name
}

resource "azurerm_cosmosdb_sql_container" "state" {
  name                = var.cosmos_container_name
  resource_group_name = azurerm_resource_group.preview.name
  account_name        = azurerm_cosmosdb_account.preview.name
  database_name       = azurerm_cosmosdb_sql_database.preview.name

  partition_key_paths   = ["/scopeId"]
  partition_key_kind    = "Hash"
  partition_key_version = 2
  default_ttl           = var.cosmos_default_ttl_seconds

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }
  }
}

# This custom data-plane role can operate only on items in the one preview
# container. It cannot create databases/containers or read account keys.
resource "azurerm_cosmosdb_sql_role_definition" "runtime_state" {
  name                = "Capture Preview State Item Operator"
  role_definition_id  = uuidv5("url", "${azurerm_cosmosdb_account.preview.id}/roles/capture-preview-state-item-operator")
  resource_group_name = azurerm_resource_group.preview.name
  account_name        = azurerm_cosmosdb_account.preview.name
  type                = "CustomRole"
  assignable_scopes   = [local.cosmos_container_scope]

  permissions {
    data_actions = [
      "Microsoft.DocumentDB/databaseAccounts/readMetadata",
      "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/*",
    ]
  }
}

resource "azurerm_cosmosdb_sql_role_assignment" "runtime_state" {
  name                = uuidv5("url", "${local.cosmos_container_scope}/assignments/${azurerm_user_assigned_identity.runtime.principal_id}")
  resource_group_name = azurerm_resource_group.preview.name
  account_name        = azurerm_cosmosdb_account.preview.name
  role_definition_id  = azurerm_cosmosdb_sql_role_definition.runtime_state.id
  principal_id        = azurerm_user_assigned_identity.runtime.principal_id
  scope               = local.cosmos_container_scope
}
