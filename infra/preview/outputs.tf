output "resource_group_name" {
  value = azurerm_resource_group.preview.name
}

output "static_web_app_name" {
  value = azurerm_static_web_app.preview.name
}

output "static_web_app_hostname" {
  value = azurerm_static_web_app.preview.default_host_name
}

output "static_web_app_url" {
  value = "https://${azurerm_static_web_app.preview.default_host_name}"
}

output "function_app_name" {
  value = azurerm_linux_function_app.preview_api.name
}

output "function_app_id" {
  value = azurerm_linux_function_app.preview_api.id
}

output "function_app_hostname" {
  description = "Direct host for diagnostics only; AuthV2 accepts linked SWA traffic and clients use the SWA /api origin."
  value       = azurerm_linux_function_app.preview_api.default_hostname
}

output "function_app_region" {
  value = azurerm_linux_function_app.preview_api.location
}

output "runtime_managed_identity_client_id" {
  value = azurerm_user_assigned_identity.runtime.client_id
}

output "runtime_managed_identity_principal_id" {
  value = azurerm_user_assigned_identity.runtime.principal_id
}

output "github_deployment_managed_identity_client_id" {
  value = azurerm_user_assigned_identity.github_deployment.client_id
}

output "github_deployment_managed_identity_principal_id" {
  value = azurerm_user_assigned_identity.github_deployment.principal_id
}

output "cosmos_endpoint" {
  value = azurerm_cosmosdb_account.preview.endpoint
}

output "cosmos_database_name" {
  value = azurerm_cosmosdb_sql_database.preview.name
}

output "cosmos_container_name" {
  value = azurerm_cosmosdb_sql_container.state.name
}

output "monthly_budget_id" {
  value = azurerm_consumption_budget_resource_group.preview.id
}

output "github_environment_variables" {
  description = "Non-secret values to set on the protected capture-preview GitHub environment. Never add the SWA deployment token as a repository secret."
  value = {
    CAPTURE_PREVIEW_AZURE_CLIENT_ID       = azurerm_user_assigned_identity.github_deployment.client_id
    CAPTURE_PREVIEW_AZURE_SUBSCRIPTION_ID = var.subscription_id
    CAPTURE_PREVIEW_AZURE_TENANT_ID       = var.tenant_id
    CAPTURE_PREVIEW_FUNCTION_APP_NAME     = azurerm_linux_function_app.preview_api.name
    CAPTURE_PREVIEW_RESOURCE_GROUP        = azurerm_resource_group.preview.name
    CAPTURE_PREVIEW_SWA_HOSTNAME          = azurerm_static_web_app.preview.default_host_name
    CAPTURE_PREVIEW_SWA_NAME              = azurerm_static_web_app.preview.name
  }
}
