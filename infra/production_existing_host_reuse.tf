variable "deploy_production_existing_host_reuse" {
  description = "Create the behaviorally dark production Scribe API, native receiver, migration job, and isolated database on the exact existing Core hosting resources. This never creates another Container Apps environment or PostgreSQL server."
  type        = bool
  default     = false
}

variable "production_existing_hosting_binding" {
  description = "Exact non-secret live Core hosting selectors used only by the dark production reuse mode. A populated binding is not deployment authority."
  type = object({
    resource_group_name                      = string
    location                                 = string
    container_app_environment_id             = string
    container_app_environment_default_domain = string
    container_apps_outbound_ipv4             = string
    postgres_server_resource_id              = string
    postgres_server_fqdn                     = string
  })
  default = null

  validation {
    condition = (
      !(var.deploy_production_existing_host_reuse || var.prepare_production_existing_host_runtime_network) ||
      try(
        var.production_existing_hosting_binding != null &&
        var.production_existing_hosting_binding.resource_group_name == "cosmaneura-prod" &&
        lower(replace(var.production_existing_hosting_binding.location, " ", "")) == "northcentralus" &&
        lower(var.production_existing_hosting_binding.container_app_environment_id) == lower(
          "/subscriptions/${var.subscription_id}/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
        ) &&
        var.production_existing_hosting_binding.container_app_environment_default_domain == "lemonsmoke-1009414c.northcentralus.azurecontainerapps.io" &&
        var.production_existing_hosting_binding.container_apps_outbound_ipv4 == "64.236.176.41" &&
        lower(var.production_existing_hosting_binding.postgres_server_resource_id) == lower(
          "/subscriptions/${var.subscription_id}/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
        ) &&
        var.production_existing_hosting_binding.postgres_server_fqdn == "cosmaneura-prod-postgres.postgres.database.azure.com",
        false,
      )
    )
    error_message = "production_existing_hosting_binding must exactly match the reviewed cosmaneura-prod Container Apps environment, outbound IPv4, and PostgreSQL server"
  }
}

locals {
  production_existing_host_reuse_contract_valid = (
    !var.deploy_production_existing_host_reuse ||
    (
      var.environment == "production" &&
      !var.deploy_production_native_edge &&
      var.deploy_container_app &&
      !var.deploy_postgres_foundation &&
      var.deploy_database_migration_job &&
      var.use_postgres_repository &&
      var.enable_workflow_authentication &&
      (!var.enable_capture_protocol || var.enable_production_existing_host_runtime) &&
      !var.enable_master_platform_handoff &&
      (!var.enable_production_native_direct_upload || var.prepare_production_existing_host_runtime_network) &&
      (!var.enable_production_native_receiver || var.enable_production_existing_host_runtime) &&
      (!var.enable_production_native_encounter_creation || var.enable_production_existing_host_runtime) &&
      !var.deploy_private_speech_foundation &&
      !var.deploy_speech_smoke_job &&
      !var.enable_speech_smoke_job &&
      !var.deploy_transcription_job &&
      !var.enable_transcription_job &&
      !var.deploy_delivery_reconciler_job &&
      !var.enable_delivery_reconciler_job &&
      !var.deploy_private_api_acceptance_job &&
      !var.enable_private_api_acceptance_job &&
      !var.allow_private_api_acceptance_invocation &&
      !var.deploy_private_terraform_runner &&
      !var.enable_private_terraform_runner &&
      !var.connect_parallel_platform_vnet &&
      var.postgres_database_name == "cosmaneura_scribe" &&
      lower(var.production_native_receiver_identity_resource_id) == lower(
        "/subscriptions/${var.subscription_id}/resourceGroups/cosmaneura-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-prod-scribe-workflow"
      ) &&
      lower(var.production_native_receiver_identity_client_id) == "c7bae168-fbf5-4658-b0d9-dd4b5373a1be" &&
      lower(var.production_core_registry_postgres_resource_id) == lower(
        "/subscriptions/${var.subscription_id}/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
      ) &&
      try(
        var.production_native_receiver_binding.core_registry_database_host == var.production_existing_hosting_binding.postgres_server_fqdn,
        false,
      ) &&
      can(regex("^[0-9a-f]{40}$", var.container_image_tag)) &&
      can(regex("^sha256:[0-9a-f]{64}$", var.container_image_digest)) &&
      can(regex("^[0-9a-f]{40}$", var.production_native_receiver_image_tag)) &&
      can(regex("^sha256:[0-9a-f]{64}$", var.production_native_receiver_image_digest)) &&
      can(regex("^[0-9a-f]{64}$", var.production_native_receiver_image_contract_sha256))
    )
  )
  production_workloads_enabled = (
    var.deploy_production_native_edge || var.deploy_production_existing_host_reuse
  )
  production_database_enabled = (
    var.deploy_postgres_foundation || var.deploy_production_existing_host_reuse
  )
  production_workload_resource_group_name = (
    var.deploy_production_existing_host_reuse
    ? try(var.production_existing_hosting_binding.resource_group_name, "")
    : local.resource_group_name
  )
  production_workload_location = (
    var.deploy_production_existing_host_reuse
    ? try(var.production_existing_hosting_binding.location, "")
    : local.resource_group_location
  )
  production_database_migration_resource_group_name = (
    var.deploy_production_existing_host_reuse
    ? try(var.production_existing_hosting_binding.resource_group_name, "")
    : local.resource_group_name
  )
  production_database_migration_location = (
    var.deploy_production_existing_host_reuse
    ? try(var.production_existing_hosting_binding.location, "")
    : local.resource_group_location
  )
  production_database_migration_environment_id = (
    var.deploy_production_existing_host_reuse
    ? try(var.production_existing_hosting_binding.container_app_environment_id, "")
    : azurerm_container_app_environment.scribe.id
  )
  production_workload_environment_id = (
    var.deploy_production_existing_host_reuse
    ? try(var.production_existing_hosting_binding.container_app_environment_id, "")
    : (
      var.deploy_production_native_edge
      ? azurerm_container_app_environment.production_native_edge[0].id
      : azurerm_container_app_environment.scribe.id
    )
  )
  production_workload_environment_default_domain = (
    var.deploy_production_existing_host_reuse
    ? try(var.production_existing_hosting_binding.container_app_environment_default_domain, "disabled.invalid")
    : (
      var.deploy_production_native_edge
      ? azurerm_container_app_environment.production_native_edge[0].default_domain
      : azurerm_container_app_environment.scribe.default_domain
    )
  )
  production_database_server_id = (
    var.deploy_production_existing_host_reuse
    ? try(var.production_existing_hosting_binding.postgres_server_resource_id, "")
    : try(azurerm_postgresql_flexible_server.scribe[0].id, "")
  )
  production_database_fqdn = (
    var.deploy_production_existing_host_reuse
    ? try(var.production_existing_hosting_binding.postgres_server_fqdn, "")
    : try(azurerm_postgresql_flexible_server.scribe[0].fqdn, "")
  )
}
