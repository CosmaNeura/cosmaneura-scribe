resource "azurerm_service_plan" "function" {
  name                = local.function_plan_name
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location
  os_type             = "Linux"
  sku_name            = "Y1"
  tags                = local.tags
}

resource "azurerm_linux_function_app" "preview_api" {
  name                = local.function_app_name
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location
  service_plan_id     = azurerm_service_plan.function.id

  storage_account_name          = azurerm_storage_account.function_host.name
  storage_uses_managed_identity = true
  content_share_force_disabled  = true

  builtin_logging_enabled                        = false
  ftp_publish_basic_authentication_enabled       = false
  functions_extension_version                    = "~4"
  https_only                                     = true
  public_network_access_enabled                  = true
  webdeploy_publish_basic_authentication_enabled = false

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.runtime.id]
  }

  app_settings = {
    "AzureWebJobsStorage__clientId"              = azurerm_user_assigned_identity.runtime.client_id
    "AzureWebJobsStorage__credential"            = "managedidentity"
    AZURE_CLIENT_ID                              = azurerm_user_assigned_identity.runtime.client_id
    CAPTURE_PREVIEW_ALLOWED_HOSTS                = azurerm_static_web_app.preview.default_host_name
    CAPTURE_PREVIEW_COSMOS_CONTAINER             = azurerm_cosmosdb_sql_container.state.name
    CAPTURE_PREVIEW_COSMOS_DATABASE              = azurerm_cosmosdb_sql_database.preview.name
    CAPTURE_PREVIEW_COSMOS_ENDPOINT              = azurerm_cosmosdb_account.preview.endpoint
    CAPTURE_PREVIEW_MANAGED_IDENTITY_CLIENT_ID   = azurerm_user_assigned_identity.runtime.client_id
    FUNCTIONS_REQUEST_BODY_SIZE_LIMIT            = "393216"
    WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID = azurerm_user_assigned_identity.runtime.id
  }

  # The SWA backend registration enables the Azure Static Web Apps provider,
  # but Azure defaults unauthenticated direct requests to a redirect. Own the
  # complete fail-closed policy here so the public Function hostname returns a
  # hard 401 and only requests authenticated by the linked SWA are admitted.
  auth_settings_v2 {
    auth_enabled           = true
    runtime_version        = "~1"
    require_authentication = true
    require_https          = true
    unauthenticated_action = "Return401"

    azure_static_web_app_v2 {
      client_id = azurerm_static_web_app.preview.default_host_name
    }

    login {
      token_store_enabled = false
    }
  }

  site_config {
    always_on                = false
    app_scale_limit          = var.function_maximum_instance_count
    ftps_state               = "Disabled"
    http2_enabled            = true
    minimum_tls_version      = "1.2"
    remote_debugging_enabled = false
    scm_minimum_tls_version  = "1.2"
    use_32_bit_worker        = false
    websockets_enabled       = false

    application_stack {
      node_version = "24"
    }
  }

  depends_on = [
    azurerm_cosmosdb_sql_role_assignment.runtime_state,
    azurerm_role_assignment.github_function_package_writer,
    azurerm_role_assignment.runtime_host_blob_owner,
  ]

  lifecycle {
    ignore_changes = [
      # AzureRM uses this create/update-only switch to omit Azure Files content
      # settings but cannot read it back from ARM. Keep the configured true
      # value for every create/replacement and ignore only its fictitious drift.
      content_share_force_disabled,
      # The pinned deployment action owns the immutable package URL; Terraform
      # owns the identity used to read it and every other app setting.
      app_settings["WEBSITE_RUN_FROM_PACKAGE"],
    ]
  }

  tags = local.tags
}

# Azure's supported OIDC deployment action documents Website Contributor as
# the required built-in role. Its assignment is limited to this one Function;
# the identity receives no resource-group or subscription Contributor role.
resource "azurerm_role_assignment" "github_function_deployment" {
  scope                            = azurerm_linux_function_app.preview_api.id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/de139f84-1756-47ae-9be6-808fbbe84772"
  principal_id                     = azurerm_user_assigned_identity.github_deployment.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true

  lifecycle {
    ignore_changes = [skip_service_principal_aad_check]
  }
}
