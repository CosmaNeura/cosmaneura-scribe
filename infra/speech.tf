resource "azurerm_cognitive_account" "speech" {
  count = var.deploy_private_speech_foundation ? 1 : 0

  name                = local.speech_account_name
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  kind                = "SpeechServices"
  sku_name            = "S0"

  custom_subdomain_name         = local.speech_account_name
  local_auth_enabled            = false
  public_network_access_enabled = false

  network_acls {
    default_action = "Deny"
    ip_rules       = []
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = local.tags
}

resource "azurerm_private_dns_zone" "speech" {
  count = var.deploy_private_speech_foundation ? 1 : 0

  name                = "privatelink.cognitiveservices.azure.com"
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "speech" {
  count = var.deploy_private_speech_foundation ? 1 : 0

  name                  = "${local.name_prefix}-speech-link"
  resource_group_name   = local.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.speech[0].name
  virtual_network_id    = azurerm_virtual_network.scribe.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "speech" {
  count = var.deploy_private_speech_foundation ? 1 : 0

  name                = "${local.name_prefix}-speech-pe"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  subnet_id           = azurerm_subnet.private_endpoints.id

  private_service_connection {
    name                           = "${local.name_prefix}-speech-connection"
    private_connection_resource_id = azurerm_cognitive_account.speech[0].id
    is_manual_connection           = false
    subresource_names              = ["account"]
  }

  private_dns_zone_group {
    name                 = "speech"
    private_dns_zone_ids = [azurerm_private_dns_zone.speech[0].id]
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.speech]
  tags       = local.tags
}

resource "azurerm_monitor_diagnostic_setting" "speech" {
  count = var.deploy_private_speech_foundation ? 1 : 0

  name                       = "${local.name_prefix}-speech-diagnostics"
  target_resource_id         = azurerm_cognitive_account.speech[0].id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.scribe.id

  enabled_log {
    category = "Audit"
  }

  enabled_log {
    category = "ManagedNetworkEvent"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_user_assigned_identity" "speech_smoke" {
  count = var.deploy_speech_smoke_job ? 1 : 0

  name                = "${local.name_prefix}-speech-smoke"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  tags                = local.tags
}

resource "azurerm_role_assignment" "speech_smoke_acr" {
  count = var.deploy_speech_smoke_job ? 1 : 0

  scope                            = azurerm_container_registry.scribe.id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d"
  principal_id                     = azurerm_user_assigned_identity.speech_smoke[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "speech_smoke_speech_user" {
  count = var.enable_speech_smoke_job ? 1 : 0

  scope                            = azurerm_cognitive_account.speech[0].id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/f2dc8367-1007-4938-bd23-fe263f013447"
  principal_id                     = azurerm_user_assigned_identity.speech_smoke[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app_job" "speech_smoke" {
  count = var.deploy_speech_smoke_job ? 1 : 0

  name                         = "cosmaneura-scribe-${local.environment_short}-smoke"
  resource_group_name          = local.resource_group_name
  location                     = local.resource_group_location
  container_app_environment_id = azurerm_container_app_environment.scribe.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 900
  replica_retry_limit          = 0

  identity {
    type = "UserAssigned"
    identity_ids = [
      azurerm_user_assigned_identity.speech_smoke[0].id,
    ]
  }

  registry {
    server   = azurerm_container_registry.scribe.login_server
    identity = azurerm_user_assigned_identity.speech_smoke[0].id
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "smoke"
      image   = local.application_image
      cpu     = 0.5
      memory  = "1Gi"
      command = ["python", "-m", "cosmaneura_scribe.speech_smoke_runner"]

      env {
        name  = "AZURE_TOKEN_CREDENTIALS"
        value = "prod"
      }

      env {
        name  = "COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID"
        value = azurerm_user_assigned_identity.speech_smoke[0].client_id
      }

      env {
        name  = "COSMANEURA_SCRIBE_SPEECH_SMOKE_ENABLED"
        value = tostring(var.enable_speech_smoke_job)
      }

      env {
        name  = "COSMANEURA_SCRIBE_TRANSCRIPTION_BACKEND"
        value = var.enable_speech_smoke_job ? "azure" : "none"
      }

      dynamic "env" {
        for_each = var.enable_speech_smoke_job ? [1] : []
        content {
          name  = "COSMANEURA_SCRIBE_AZURE_SPEECH_ENDPOINT"
          value = azurerm_cognitive_account.speech[0].endpoint
        }
      }

      dynamic "env" {
        for_each = var.enable_speech_smoke_job ? [1] : []
        content {
          name = "COSMANEURA_SCRIBE_AZURE_SPEECH_PRIVATE_ENDPOINT_CIDRS"
          value = jsonencode([
            "${azurerm_private_endpoint.speech[0].private_service_connection[0].private_ip_address}/32"
          ])
        }
      }
    }
  }

  depends_on = [
    azurerm_private_dns_zone_virtual_network_link.speech,
    azurerm_private_endpoint.speech,
    azurerm_role_assignment.speech_smoke_acr,
    azurerm_role_assignment.speech_smoke_speech_user,
  ]

  tags = local.tags
}
