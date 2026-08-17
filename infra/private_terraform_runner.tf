locals {
  private_terraform_runner_tags = merge(local.tags, {
    purpose              = "private-terraform-bootstrap"
    runner_source_commit = var.private_terraform_runner_image_tag
    temporary            = "true"
  })

  # The explicit non-secret live manifest is passed in full, but the fixed entrypoint can target
  # only the key, migrated runtime role, and existing API.
  private_terraform_runner_tf_variables = {
    subscription_id                          = var.subscription_id
    tenant_id                                = var.tenant_id
    environment                              = var.environment
    location                                 = var.location
    resource_group_name                      = var.resource_group_name
    create_resource_group                    = jsonencode(var.create_resource_group)
    storage_account_name                     = var.storage_account_name
    key_vault_name                           = var.key_vault_name
    virtual_network_address_space            = jsonencode(var.virtual_network_address_space)
    private_endpoint_subnet_address_prefixes = jsonencode(var.private_endpoint_subnet_address_prefixes)
    container_apps_subnet_address_prefixes   = jsonencode(var.container_apps_subnet_address_prefixes)
    postgres_subnet_address_prefixes         = jsonencode(var.postgres_subnet_address_prefixes)
    container_registry_name                  = var.container_registry_name
    enable_phi_safe_data_plane_diagnostics   = jsonencode(var.enable_phi_safe_data_plane_diagnostics)
    enable_development_cost_guardrails       = jsonencode(var.enable_development_cost_guardrails)
    development_monthly_budget_usd           = jsonencode(var.development_monthly_budget_usd)
    development_budget_start_date            = var.development_budget_start_date
    development_budget_notification_action_group_ids = jsonencode(
      sort(tolist(var.development_budget_notification_action_group_ids))
    )
    enable_log_analytics_audit_baseline        = jsonencode(var.enable_log_analytics_audit_baseline)
    log_analytics_retention_in_days            = jsonencode(var.log_analytics_retention_in_days)
    log_analytics_daily_quota_gb               = jsonencode(var.log_analytics_daily_quota_gb)
    deploy_container_app                       = jsonencode(var.deploy_container_app)
    container_image_repository                 = var.container_image_repository
    container_image_tag                        = var.container_image_tag
    enable_master_platform_handoff             = jsonencode(var.enable_master_platform_handoff)
    master_platform_base_url                   = var.master_platform_base_url
    master_platform_scope                      = var.master_platform_scope
    enable_workflow_authentication             = jsonencode(var.enable_workflow_authentication)
    workflow_api_audience                      = var.workflow_api_audience
    trusted_platform_client_id                 = var.trusted_platform_client_id
    deploy_private_api_acceptance_job          = jsonencode(true)
    enable_private_api_acceptance_job          = jsonencode(false)
    allow_private_api_acceptance_invocation    = jsonencode(false)
    platform_workflow_identity_resource_id     = var.platform_workflow_identity_resource_id
    private_api_acceptance_tenant_id           = var.private_api_acceptance_tenant_id
    private_api_acceptance_image_tag           = var.private_api_acceptance_image_tag
    private_api_acceptance_image_digest        = var.private_api_acceptance_image_digest
    deploy_private_terraform_runner            = jsonencode(true)
    enable_private_terraform_runner            = jsonencode(true)
    private_terraform_reconciliation_completed = jsonencode(false)
    private_terraform_runner_image_repository  = var.private_terraform_runner_image_repository
    private_terraform_runner_image_tag         = var.private_terraform_runner_image_tag
    private_terraform_runner_image_digest      = var.private_terraform_runner_image_digest
    terraform_state_container_resource_id      = var.terraform_state_container_resource_id
    terraform_state_resource_group_name        = var.terraform_state_resource_group_name
    terraform_state_storage_account_name       = var.terraform_state_storage_account_name
    terraform_state_container_name             = var.terraform_state_container_name
    terraform_state_key                        = var.terraform_state_key
    private_terraform_plan_blob_name           = var.private_terraform_plan_blob_name
    connect_parallel_platform_vnet             = jsonencode(var.connect_parallel_platform_vnet)
    parallel_platform_vnet_id                  = var.parallel_platform_vnet_id
    deploy_postgres_foundation                 = jsonencode(var.deploy_postgres_foundation)
    deploy_database_migration_job              = jsonencode(var.deploy_database_migration_job)
    use_postgres_repository                    = jsonencode(var.use_postgres_repository)
    deploy_transcription_job                   = jsonencode(var.deploy_transcription_job)
    enable_transcription_job                   = jsonencode(var.enable_transcription_job)
    deploy_delivery_reconciler_job             = jsonencode(var.deploy_delivery_reconciler_job)
    enable_delivery_reconciler_job             = jsonencode(var.enable_delivery_reconciler_job)
    deploy_private_speech_foundation           = jsonencode(var.deploy_private_speech_foundation)
    deploy_speech_smoke_job                    = jsonencode(var.deploy_speech_smoke_job)
    enable_speech_smoke_job                    = jsonencode(var.enable_speech_smoke_job)
    postgres_server_name                       = var.postgres_server_name
    postgres_database_name                     = var.postgres_database_name
    postgres_sku_name                          = var.postgres_sku_name
    postgres_storage_mb                        = jsonencode(var.postgres_storage_mb)
    tags                                       = jsonencode(var.tags)
  }

  private_terraform_runner_common_env = merge(
    {
      ARM_CLIENT_ID                                       = var.deploy_private_terraform_runner ? azurerm_user_assigned_identity.private_terraform_runner[0].client_id : "disabled"
      ARM_PROVIDER_ENHANCED_VALIDATION_RESOURCE_PROVIDERS = "false"
      ARM_RESOURCE_PROVIDER_REGISTRATIONS                 = "none"
      ARM_SUBSCRIPTION_ID                                 = var.subscription_id
      ARM_TENANT_ID                                       = var.tenant_id
      ARM_USE_CLI                                         = "true"
      ARM_USE_MSI                                         = "false"
      AZURE_CONFIG_DIR                                    = "/tmp/.azure"
      TF_CLI_CONFIG_FILE                                  = "/workspace/infra/runner/tofurc"
      TF_IN_AUTOMATION                                    = "true"
      TF_RUNNER_ENABLED                                   = tostring(var.enable_private_terraform_runner)
      TF_RUNNER_EXPECTED_PLAN_SHA256                      = "review-required"
      TF_RUNNER_EXPECTED_STATE_LINEAGE                    = "review-required"
      TF_RUNNER_EXPECTED_STATE_SERIAL                     = "review-required"
      TF_STATE_RESOURCE_GROUP                             = var.enable_private_terraform_runner ? var.terraform_state_resource_group_name : "disabled"
      TF_STATE_STORAGE_ACCOUNT                            = var.enable_private_terraform_runner ? var.terraform_state_storage_account_name : "disabled"
      TF_STATE_CONTAINER                                  = var.enable_private_terraform_runner ? var.terraform_state_container_name : "disabled"
      TF_STATE_KEY                                        = var.enable_private_terraform_runner ? var.terraform_state_key : "disabled"
      TF_RUNNER_PLAN_BLOB                                 = var.enable_private_terraform_runner ? var.private_terraform_plan_blob_name : "disabled.tfplan"
    },
    {
      for name, value in local.private_terraform_runner_tf_variables :
      "TF_VAR_${name}" => value
    },
  )
}

resource "azurerm_user_assigned_identity" "private_terraform_runner" {
  count = var.deploy_private_terraform_runner ? 1 : 0

  name                = "${local.name_prefix}-private-tf-runner"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.private_terraform_runner_tags
}

resource "azurerm_role_assignment" "private_terraform_runner_acr" {
  count = var.deploy_private_terraform_runner ? 1 : 0

  scope                            = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}/providers/Microsoft.ContainerRegistry/registries/${var.container_registry_name}"
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d"
  principal_id                     = azurerm_user_assigned_identity.private_terraform_runner[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "private_terraform_runner_resource_reader" {
  count = var.enable_private_terraform_runner ? 1 : 0

  scope                            = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}"
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7"
  principal_id                     = azurerm_user_assigned_identity.private_terraform_runner[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "private_terraform_runner_state" {
  count = var.enable_private_terraform_runner ? 1 : 0

  scope                            = var.terraform_state_container_resource_id
  role_definition_id               = azurerm_role_definition.private_terraform_runner_state[0].role_definition_resource_id
  principal_id                     = azurerm_user_assigned_identity.private_terraform_runner[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
  condition_version                = "2.0"
  condition                        = <<-EOT
    (
      (
        ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'}
        AND
        SubOperationMatches{'Blob.List'}
        AND
        @Request[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:prefix] StringEquals '${var.terraform_state_key}env:'
      )
      OR
      (
        !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'} AND SubOperationMatches{'Blob.List'})
        AND
        (
          @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringEquals '${var.terraform_state_key}'
          OR
          @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringEquals '${var.private_terraform_plan_blob_name}'
          OR
          @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringEquals '${var.private_terraform_plan_blob_name}.manifest.json'
        )
        AND
        (
          !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete'})
          OR
          @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringNotEquals '${var.terraform_state_key}'
        )
      )
    )
  EOT
}

resource "azurerm_role_definition" "private_terraform_runner_state" {
  count = var.enable_private_terraform_runner ? 1 : 0

  name        = "${local.name_prefix}-private-tf-state-objects"
  scope       = "/subscriptions/${var.subscription_id}/resourceGroups/${var.terraform_state_resource_group_name}"
  description = "Temporary exact-object access for the private Scribe Terraform runner."

  permissions {
    actions     = []
    not_actions = []
    data_actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
    ]
    not_data_actions = []
  }

  assignable_scopes = [
    "/subscriptions/${var.subscription_id}/resourceGroups/${var.terraform_state_resource_group_name}",
  ]
}

resource "azurerm_role_assignment" "private_terraform_runner_key_officer" {
  count = var.enable_private_terraform_runner ? 1 : 0

  scope                            = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}/providers/Microsoft.KeyVault/vaults/${var.key_vault_name}"
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/14b46e9e-c2b7-41b4-b07b-48a6ebf60603"
  principal_id                     = azurerm_user_assigned_identity.private_terraform_runner[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "private_terraform_runner_api_contributor" {
  count = var.enable_private_terraform_runner ? 1 : 0

  scope                            = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}/providers/Microsoft.App/containerApps/${local.container_app_name}"
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/358470bc-b998-42bd-ab17-a7e34c199c0f"
  principal_id                     = azurerm_user_assigned_identity.private_terraform_runner[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "private_terraform_runner_vault_rbac_admin" {
  count = var.enable_private_terraform_runner ? 1 : 0

  scope                            = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}/providers/Microsoft.KeyVault/vaults/${var.key_vault_name}"
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/f58310d9-a9f6-439a-9e8d-f62e7b41a168"
  principal_id                     = azurerm_user_assigned_identity.private_terraform_runner[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app_job" "private_terraform_runner" {
  for_each = var.deploy_private_terraform_runner ? toset(["apply", "plan"]) : toset([])

  name                         = "cosmaneura-scribe-${local.environment_short}-tf-${each.key}"
  resource_group_name          = var.resource_group_name
  location                     = var.location
  container_app_environment_id = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}/providers/Microsoft.App/managedEnvironments/${local.name_prefix}-environment"
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 3600
  replica_retry_limit          = 0

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.private_terraform_runner[0].id]
  }

  registry {
    server   = "${var.container_registry_name}.azurecr.io"
    identity = azurerm_user_assigned_identity.private_terraform_runner[0].id
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "runner"
      image   = "${var.container_registry_name}.azurecr.io/${var.private_terraform_runner_image_repository}@${var.private_terraform_runner_image_digest}"
      cpu     = 0.5
      memory  = "1Gi"
      command = ["/workspace/infra/runner/run.sh"]

      dynamic "env" {
        for_each = {
          for name, value in merge(local.private_terraform_runner_common_env, {
            TF_RUNNER_ACTION = each.key
          }) : name => value if value != ""
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [
    azurerm_network_security_group.container_apps,
    azurerm_role_assignment.private_terraform_runner_acr,
    azurerm_role_assignment.private_terraform_runner_api_contributor,
    azurerm_role_assignment.private_terraform_runner_key_officer,
    azurerm_role_assignment.private_terraform_runner_resource_reader,
    azurerm_role_assignment.private_terraform_runner_state,
    azurerm_role_assignment.private_terraform_runner_vault_rbac_admin,
  ]

  tags = local.private_terraform_runner_tags
}
