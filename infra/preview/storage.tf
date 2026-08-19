resource "azurerm_storage_account" "function_host" {
  name                = local.function_storage_name
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location

  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "LRS"
  access_tier                       = "Hot"
  allow_nested_items_to_be_public   = false
  cross_tenant_replication_enabled  = false
  default_to_oauth_authentication   = true
  https_traffic_only_enabled        = true
  infrastructure_encryption_enabled = true
  local_user_enabled                = false
  min_tls_version                   = "TLS1_2"
  public_network_access_enabled     = true
  shared_access_key_enabled         = false

  blob_properties {
    # This account is disposable Function-host state, not the Terraform
    # backend. Avoid unbounded versions of frequently updated host blobs.
    versioning_enabled = false

    container_delete_retention_policy {
      days = 7
    }

    delete_retention_policy {
      days = 7
    }
  }

  tags = local.tags
}

# The deployed package has HTTP routes only, with no Blob, Queue, or Timer
# binding. Microsoft's current host-required storage table identifies Storage
# Blob Data Owner as the minimum AzureWebJobsStorage role for that shape.
resource "azurerm_role_assignment" "runtime_host_blob_owner" {
  scope                            = azurerm_storage_account.function_host.id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/b7e6dc6d-f1e8-4753-8033-0f276bb0955b"
  principal_id                     = azurerm_user_assigned_identity.runtime.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true

  lifecycle {
    ignore_changes = [skip_service_principal_aad_check]
  }
}

# Azure/functions-action uses this exact private container for Linux
# Consumption run-from-package deployment when authenticating with OIDC/RBAC.
resource "azurerm_storage_container" "function_deployment" {
  name                  = "github-actions-deploy"
  storage_account_id    = azurerm_storage_account.function_host.id
  container_access_type = "private"
}

resource "azurerm_role_assignment" "github_function_package_writer" {
  scope                            = azurerm_storage_container.function_deployment.id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe"
  principal_id                     = azurerm_user_assigned_identity.github_deployment.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true

  lifecycle {
    ignore_changes = [skip_service_principal_aad_check]
  }
}
