locals {
  normalized_location = lower(replace(var.location, " ", ""))
  name_prefix         = "cmn-capture-preview"

  static_web_app_name      = "${local.name_prefix}-${var.resource_suffix}"
  function_app_name        = "cmn-cap-prev-api-${var.resource_suffix}"
  function_plan_name       = "${local.name_prefix}-plan-${var.resource_suffix}"
  function_storage_name    = "cmnprev${var.resource_suffix}"
  cosmos_account_name      = "${local.name_prefix}-${var.resource_suffix}"
  runtime_identity_name    = "${local.name_prefix}-runtime-${var.resource_suffix}"
  deployment_identity_name = "${local.name_prefix}-github-${var.resource_suffix}"

  cosmos_container_scope = "${azurerm_cosmosdb_account.preview.id}/dbs/${azurerm_cosmosdb_sql_database.preview.name}/colls/${azurerm_cosmosdb_sql_container.state.name}"

  tags = merge(var.tags, {
    application         = "cosmaneura-scribe-capture"
    clinical-use        = "prohibited"
    data-classification = "synthetic-only"
    environment         = "capture-preview"
    managed-by          = "opentofu"
  })
}
