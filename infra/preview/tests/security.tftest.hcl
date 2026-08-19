mock_provider "azurerm" {
  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mock-preview-identity"
      client_id    = "00000000-0000-4000-8000-000000000003"
      principal_id = "00000000-0000-4000-8000-000000000004"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.Storage/storageAccounts/cmnprevp8x6m2"
    }
  }

  mock_resource "azurerm_storage_container" {
    defaults = {
      id = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.Storage/storageAccounts/cmnprevp8x6m2/blobServices/default/containers/github-actions-deploy"
    }
  }

  mock_resource "azurerm_cosmosdb_account" {
    defaults = {
      id       = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.DocumentDB/databaseAccounts/cmn-capture-preview-p8x6m2"
      endpoint = "https://cmn-capture-preview-p8x6m2.documents.azure.com:443/"
    }
  }

  mock_resource "azurerm_cosmosdb_sql_database" {
    defaults = {
      id = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.DocumentDB/databaseAccounts/cmn-capture-preview-p8x6m2/sqlDatabases/capture-preview"
    }
  }

  mock_resource "azurerm_cosmosdb_sql_container" {
    defaults = {
      id = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.DocumentDB/databaseAccounts/cmn-capture-preview-p8x6m2/sqlDatabases/capture-preview/containers/workflow-state"
    }
  }

  mock_resource "azurerm_cosmosdb_sql_role_definition" {
    defaults = {
      id = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.DocumentDB/databaseAccounts/cmn-capture-preview-p8x6m2/sqlRoleDefinitions/00000000-0000-4000-8000-000000000005"
    }
  }

  mock_resource "azurerm_service_plan" {
    defaults = {
      id = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.Web/serverFarms/cmn-capture-preview-plan-p8x6m2"
    }
  }

  mock_resource "azurerm_linux_function_app" {
    defaults = {
      id               = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.Web/sites/cmn-cap-prev-api-p8x6m2"
      default_hostname = "cmn-cap-prev-api-p8x6m2.azurewebsites.net"
    }
  }

  mock_resource "azurerm_static_web_app" {
    defaults = {
      id                = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/cosmaneura-capture-preview-development/providers/Microsoft.Web/staticSites/cmn-capture-preview-p8x6m2"
      default_host_name = "synthetic-mock.azurestaticapps.net"
    }
  }

  mock_resource "azurerm_role_definition" {
    defaults = {
      id                          = "/subscriptions/00000000-0000-4000-8000-000000000001/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-4000-8000-000000000006"
      role_definition_resource_id = "/subscriptions/00000000-0000-4000-8000-000000000001/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-4000-8000-000000000006"
    }
  }
}

run "synthetic_preview_security_boundaries" {
  command = plan

  variables {
    subscription_id   = "00000000-0000-4000-8000-000000000001"
    tenant_id         = "00000000-0000-4000-8000-000000000002"
    resource_suffix   = "p8x6m2"
    budget_start_date = "2026-08-01T00:00:00Z"
  }

  assert {
    condition     = azurerm_cosmosdb_account.preview.local_authentication_enabled == false
    error_message = "Cosmos DB local/key authentication must stay disabled."
  }

  assert {
    condition = (
      length(azurerm_cosmosdb_sql_role_definition.runtime_state.permissions) == 1 &&
      length(one(azurerm_cosmosdb_sql_role_definition.runtime_state.permissions).data_actions) == 2 &&
      contains(one(azurerm_cosmosdb_sql_role_definition.runtime_state.permissions).data_actions, "Microsoft.DocumentDB/databaseAccounts/readMetadata") &&
      contains(one(azurerm_cosmosdb_sql_role_definition.runtime_state.permissions).data_actions, "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/*")
    )
    error_message = "The runtime Cosmos role must remain limited to metadata and exact-container item operations."
  }

  assert {
    condition = (
      length(azurerm_cosmosdb_sql_container.state.partition_key_paths) == 1 &&
      azurerm_cosmosdb_sql_container.state.partition_key_paths[0] == "/scopeId"
    )
    error_message = "Preview state must remain partitioned by the validated scope ID."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_container.state.default_ttl == 86400
    error_message = "Synthetic preview control state must expire within 24 hours."
  }

  assert {
    condition     = azurerm_storage_account.function_host.shared_access_key_enabled == false
    error_message = "Function host storage must use managed identity, not shared keys."
  }

  assert {
    condition = (
      azurerm_storage_container.function_deployment.name == "github-actions-deploy" &&
      azurerm_storage_container.function_deployment.container_access_type == "private" &&
      azurerm_role_assignment.github_function_package_writer.scope == azurerm_storage_container.function_deployment.id
    )
    error_message = "GitHub may write Function packages only to the exact private deployment container."
  }

  assert {
    condition     = azurerm_linux_function_app.preview_api.https_only == true
    error_message = "The preview Function must accept HTTPS only."
  }

  assert {
    condition = (
      azurerm_linux_function_app.preview_api.ftp_publish_basic_authentication_enabled == false &&
      azurerm_linux_function_app.preview_api.webdeploy_publish_basic_authentication_enabled == false
    )
    error_message = "Basic-auth publishing endpoints must remain disabled."
  }

  assert {
    condition = (
      azurerm_linux_function_app.preview_api.app_settings.CAPTURE_PREVIEW_ALLOWED_HOSTS == azurerm_static_web_app.preview.default_host_name &&
      azurerm_linux_function_app.preview_api.app_settings.CAPTURE_PREVIEW_MANAGED_IDENTITY_CLIENT_ID == azurerm_user_assigned_identity.runtime.client_id &&
      azurerm_linux_function_app.preview_api.app_settings.FUNCTIONS_REQUEST_BODY_SIZE_LIMIT == "393216" &&
      azurerm_linux_function_app.preview_api.app_settings.WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID == azurerm_user_assigned_identity.runtime.id
    )
    error_message = "The Function must bind its allowed host and Cosmos credential selection to Terraform-owned resources."
  }

  assert {
    condition = (
      azurerm_static_web_app.preview.sku_tier == "Standard" &&
      azurerm_static_web_app.preview.preview_environments_enabled == false &&
      azurerm_static_web_app.preview.configuration_file_changes_enabled == true
    )
    error_message = "The dedicated SWA must expose only its stable environment and honor the trusted routing config."
  }

  assert {
    condition     = azurerm_federated_identity_credential.github_environment.subject == "repo:CosmaNeura/cosmaneura-scribe:environment:capture-preview"
    error_message = "Azure federation must trust only the protected capture-preview GitHub environment."
  }

  assert {
    condition = (
      length(azurerm_role_definition.github_static_preview.permissions[0].actions) == 2 &&
      contains(azurerm_role_definition.github_static_preview.permissions[0].actions, "Microsoft.Web/staticSites/read") &&
      contains(azurerm_role_definition.github_static_preview.permissions[0].actions, "Microsoft.Web/staticSites/listsecrets/action")
    )
    error_message = "The GitHub SWA role must remain token-read-only."
  }

  assert {
    condition     = local.tags["data-classification"] == "synthetic-only" && local.tags["clinical-use"] == "prohibited"
    error_message = "Every resource must retain the synthetic-only and clinical-use-prohibited boundary tags."
  }
}
