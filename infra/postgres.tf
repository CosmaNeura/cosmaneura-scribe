resource "azurerm_subnet" "postgres" {
  count = var.deploy_postgres_foundation ? 1 : 0

  name                 = "postgres"
  resource_group_name  = local.resource_group_name
  virtual_network_name = azurerm_virtual_network.scribe.name
  address_prefixes     = var.postgres_subnet_address_prefixes

  delegation {
    name = "Microsoft.DBforPostgreSQL.flexibleServers"

    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_private_dns_zone" "postgres" {
  count = var.deploy_postgres_foundation ? 1 : 0

  name                = "cosmaneura-scribe.postgres.database.azure.com"
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  count = var.deploy_postgres_foundation ? 1 : 0

  name                  = "${local.name_prefix}-postgres-link"
  resource_group_name   = local.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.postgres[0].name
  virtual_network_id    = azurerm_virtual_network.scribe.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_user_assigned_identity" "database_migrations" {
  count = var.deploy_postgres_foundation ? 1 : 0

  name                = "${local.name_prefix}-database-migrations"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  tags                = local.tags
}

resource "azurerm_role_assignment" "database_migrations_acr" {
  count = var.deploy_postgres_foundation ? 1 : 0

  scope                = azurerm_container_registry.scribe.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.database_migrations[0].principal_id
}

resource "azurerm_postgresql_flexible_server" "scribe" {
  count = var.deploy_postgres_foundation ? 1 : 0

  name                = var.postgres_server_name
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

  version                       = "16"
  delegated_subnet_id           = azurerm_subnet.postgres[0].id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres[0].id
  public_network_access_enabled = false
  sku_name                      = var.postgres_sku_name
  storage_mb                    = var.postgres_storage_mb
  auto_grow_enabled             = false
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false
    tenant_id                     = var.tenant_id
  }

  identity {
    type = "SystemAssigned"
  }

  maintenance_window {
    day_of_week  = 0
    start_hour   = 7
    start_minute = 0
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
  tags       = local.tags
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "migrations" {
  count = var.deploy_postgres_foundation ? 1 : 0

  server_name         = azurerm_postgresql_flexible_server.scribe[0].name
  resource_group_name = local.resource_group_name
  tenant_id           = var.tenant_id
  object_id           = azurerm_user_assigned_identity.database_migrations[0].principal_id
  principal_name      = azurerm_user_assigned_identity.database_migrations[0].name
  principal_type      = "ServicePrincipal"
}

resource "azurerm_postgresql_flexible_server_database" "scribe" {
  count = var.deploy_postgres_foundation ? 1 : 0

  name      = var.postgres_database_name
  server_id = azurerm_postgresql_flexible_server.scribe[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    azurerm_postgresql_flexible_server_active_directory_administrator.migrations,
  ]
}

resource "azurerm_monitor_diagnostic_setting" "postgres" {
  count = var.deploy_postgres_foundation ? 1 : 0

  name                       = "${local.name_prefix}-postgres-diagnostics"
  target_resource_id         = azurerm_postgresql_flexible_server.scribe[0].id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.scribe.id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_container_app_job" "database_migrations" {
  count = var.deploy_database_migration_job ? 1 : 0

  name                         = "cosmaneura-scribe-${local.environment_short}-migrate"
  resource_group_name          = local.resource_group_name
  location                     = local.resource_group_location
  container_app_environment_id = azurerm_container_app_environment.scribe.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 900
  replica_retry_limit          = 1

  identity {
    type = "UserAssigned"
    identity_ids = [
      azurerm_user_assigned_identity.database_migrations[0].id,
    ]
  }

  registry {
    server   = azurerm_container_registry.scribe.login_server
    identity = azurerm_user_assigned_identity.database_migrations[0].id
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "migrate"
      image   = "${azurerm_container_registry.scribe.login_server}/${var.container_image_repository}:${var.container_image_tag}"
      cpu     = 0.5
      memory  = "1Gi"
      command = ["python"]
      args    = ["-m", "cosmaneura_scribe.database_bootstrap"]

      env {
        name  = "AZURE_TOKEN_CREDENTIALS"
        value = "prod"
      }

      env {
        name  = "COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID"
        value = azurerm_user_assigned_identity.database_migrations[0].client_id
      }

      env {
        name  = "COSMANEURA_SCRIBE_REPOSITORY_BACKEND"
        value = "postgres"
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_HOST"
        value = azurerm_postgresql_flexible_server.scribe[0].fqdn
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_NAME"
        value = azurerm_postgresql_flexible_server_database.scribe[0].name
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_USER"
        value = azurerm_user_assigned_identity.database_migrations[0].name
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_RUNTIME_PRINCIPAL_NAME"
        value = azurerm_user_assigned_identity.runtime.name
      }

      env {
        name  = "COSMANEURA_SCRIBE_DATABASE_RUNTIME_PRINCIPAL_OBJECT_ID"
        value = azurerm_user_assigned_identity.runtime.principal_id
      }
    }
  }

  depends_on = [
    azurerm_postgresql_flexible_server_database.scribe,
    azurerm_role_assignment.database_migrations_acr,
  ]

  tags = local.tags
}
