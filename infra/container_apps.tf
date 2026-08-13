resource "azurerm_subnet" "container_apps" {
  name                 = "container-apps"
  resource_group_name  = local.resource_group_name
  virtual_network_name = azurerm_virtual_network.scribe.name
  address_prefixes     = var.container_apps_subnet_address_prefixes

  delegation {
    name = "Microsoft.App.environments"

    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_log_analytics_workspace" "scribe" {
  name                = "${local.name_prefix}-logs"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

  sku               = "PerGB2018"
  retention_in_days = 30
  daily_quota_gb    = 0.5

  tags = local.tags
}

resource "azurerm_container_registry" "scribe" {
  name                = var.container_registry_name
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  sku                 = "Basic"

  admin_enabled                                = false
  anonymous_pull_enabled                       = false
  azuread_authentication_as_arm_policy_enabled = true
  data_endpoint_enabled                        = false
  public_network_access_enabled                = true

  tags = local.tags
}

resource "azurerm_role_assignment" "runtime_acr" {
  scope                = azurerm_container_registry.scribe.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
}

resource "azurerm_container_app_environment" "scribe" {
  name                = "${local.name_prefix}-environment"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

  infrastructure_resource_group_name = "${local.name_prefix}-managed"
  infrastructure_subnet_id           = azurerm_subnet.container_apps.id
  internal_load_balancer_enabled     = true
  log_analytics_workspace_id         = azurerm_log_analytics_workspace.scribe.id
  logs_destination                   = "log-analytics"
  public_network_access              = "Disabled"
  zone_redundancy_enabled            = false

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  tags = local.tags
}

resource "azurerm_private_dns_zone" "container_apps" {
  name                = azurerm_container_app_environment.scribe.default_domain
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "container_apps" {
  name                  = "${local.name_prefix}-container-apps-link"
  resource_group_name   = local.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.container_apps.name
  virtual_network_id    = azurerm_virtual_network.scribe.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_dns_a_record" "container_apps_wildcard" {
  name                = "*"
  zone_name           = azurerm_private_dns_zone.container_apps.name
  resource_group_name = local.resource_group_name
  ttl                 = 60
  records             = [azurerm_container_app_environment.scribe.static_ip_address]
  tags                = local.tags
}

resource "azurerm_container_app" "api" {
  count = var.deploy_container_app ? 1 : 0

  name                         = local.container_app_name
  resource_group_name          = local.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.scribe.id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  max_inactive_revisions       = 3

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.runtime.id]
  }

  registry {
    server   = azurerm_container_registry.scribe.login_server
    identity = azurerm_user_assigned_identity.runtime.id
  }

  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 8020
    transport                  = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas                     = 0
    max_replicas                     = 1
    termination_grace_period_seconds = 30

    container {
      name   = "api"
      image  = "${azurerm_container_registry.scribe.login_server}/${var.container_image_repository}:${var.container_image_tag}"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "AZURE_TOKEN_CREDENTIALS"
        value = "prod"
      }

      env {
        name  = "COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID"
        value = azurerm_user_assigned_identity.runtime.client_id
      }

      env {
        name  = "COSMANEURA_SCRIBE_MASTER_PLATFORM_HANDOFF_ENABLED"
        value = tostring(var.enable_master_platform_handoff)
      }

      dynamic "env" {
        for_each = var.enable_master_platform_handoff ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_MASTER_PLATFORM_BASE_URL"
          value = var.master_platform_base_url
        }
      }

      dynamic "env" {
        for_each = var.enable_master_platform_handoff ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_MASTER_PLATFORM_SCOPE"
          value = var.master_platform_scope
        }
      }

      env {
        name  = "COSMANEURA_SCRIBE_STORAGE_ACCOUNT_URL"
        value = azurerm_storage_account.audio.primary_blob_endpoint
      }

      env {
        name  = "COSMANEURA_SCRIBE_STORAGE_BACKEND"
        value = "azure"
      }

      env {
        name  = "COSMANEURA_SCRIBE_STORAGE_CONTAINER_NAME"
        value = azurerm_storage_container.audio.name
      }

      dynamic "env" {
        for_each = var.use_postgres_repository ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_REPOSITORY_BACKEND"
          value = "postgres"
        }
      }

      dynamic "env" {
        for_each = var.use_postgres_repository ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_DATABASE_HOST"
          value = azurerm_postgresql_flexible_server.scribe[0].fqdn
        }
      }

      dynamic "env" {
        for_each = var.use_postgres_repository ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_DATABASE_NAME"
          value = azurerm_postgresql_flexible_server_database.scribe[0].name
        }
      }

      dynamic "env" {
        for_each = var.use_postgres_repository ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_DATABASE_USER"
          value = azurerm_user_assigned_identity.runtime.name
        }
      }

      liveness_probe {
        transport        = "HTTP"
        port             = 8020
        path             = "/healthz"
        initial_delay    = 10
        interval_seconds = 30
        timeout          = 5
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = 8020
        path                    = var.use_postgres_repository ? "/readyz" : "/healthz"
        initial_delay           = 5
        interval_seconds        = 10
        timeout                 = 5
        success_count_threshold = 1
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "20"
    }
  }

  depends_on = [
    azurerm_private_endpoint.audio_blob,
    azurerm_role_assignment.runtime_acr,
  ]

  tags = local.tags
}
