resource "azurerm_monitor_data_collection_rule" "phi_safe_workspace" {
  count = var.enable_phi_safe_data_plane_diagnostics ? 1 : 0

  name                = "${local.name_prefix}-phi-safe-workspace-transform"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  kind                = "WorkspaceTransforms"

  destinations {
    log_analytics {
      name                  = "scribe-workspace"
      workspace_resource_id = "/subscriptions/${var.subscription_id}/resourceGroups/${local.resource_group_name}/providers/Microsoft.OperationalInsights/workspaces/${local.name_prefix}-logs"
    }
  }

  data_flow {
    streams      = ["Microsoft-Table-StorageBlobLogs"]
    destinations = ["scribe-workspace"]
    transform_kql = (
      "source | project-away Uri, ObjectKey, SourceUri, DestinationUri"
    )
  }

  tags = local.tags
}

resource "azurerm_monitor_diagnostic_setting" "audio_blob" {
  count = var.enable_phi_safe_data_plane_diagnostics ? 1 : 0

  name                           = "${local.name_prefix}-blob-diagnostics"
  target_resource_id             = "${azurerm_storage_account.audio.id}/blobServices/default"
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.scribe.id
  log_analytics_destination_type = "Dedicated"

  enabled_log {
    category = "StorageRead"
  }

  enabled_log {
    category = "StorageWrite"
  }

  enabled_log {
    category = "StorageDelete"
  }

  enabled_metric {
    category = "Transaction"
  }
}

resource "azurerm_monitor_diagnostic_setting" "key_vault" {
  count = var.enable_phi_safe_data_plane_diagnostics ? 1 : 0

  name                       = "${local.name_prefix}-vault-diagnostics"
  target_resource_id         = azurerm_key_vault.scribe.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.scribe.id

  enabled_log {
    category = "AuditEvent"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}
