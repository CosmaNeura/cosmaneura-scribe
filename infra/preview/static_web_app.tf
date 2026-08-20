resource "azurerm_static_web_app" "preview" {
  name                = local.static_web_app_name
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location

  sku_tier                           = "Standard"
  sku_size                           = "Standard"
  configuration_file_changes_enabled = true
  preview_environments_enabled       = false
  public_network_access_enabled      = true

  # Omission of basic_auth is intentional. SWA provides HTTPS and no shared
  # site password is created or stored in Terraform state.
  tags = local.tags
}

# Azure applies AuthV2 to the Function when this stable default-environment
# registration is created. Pull requests never receive a cloud environment.
resource "azurerm_static_web_app_function_app_registration" "preview_api" {
  static_web_app_id = azurerm_static_web_app.preview.id
  function_app_id   = azurerm_linux_function_app.preview_api.id
}

resource "azurerm_role_definition" "github_static_preview" {
  name               = "CosmaNeura Capture Preview SWA Linker ${var.resource_suffix}"
  role_definition_id = uuidv5("url", "${azurerm_resource_group.preview.id}/roles/capture-preview-swa-linker-${var.resource_suffix}")
  scope              = azurerm_resource_group.preview.id
  assignable_scopes  = [azurerm_resource_group.preview.id]
  description        = "Retrieve the deployment token for one synthetic preview Static Web App."

  permissions {
    actions = [
      "Microsoft.Web/staticSites/read",
      "Microsoft.Web/staticSites/listsecrets/action",
    ]
    not_actions = []
  }
}

resource "azurerm_role_assignment" "github_static_preview" {
  scope                            = azurerm_static_web_app.preview.id
  role_definition_id               = azurerm_role_definition.github_static_preview.role_definition_resource_id
  principal_id                     = azurerm_user_assigned_identity.github_deployment.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true

  lifecycle {
    ignore_changes = [skip_service_principal_aad_check]
  }
}
