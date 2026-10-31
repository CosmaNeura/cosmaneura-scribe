# One logical database on the existing Core server. This does not create a
# server, identity, job, app, grant, network rule, or runtime configuration.
variable "prepare_production_core_bundle_database" {
  description = "Prepare only the isolated cosmaneura_scribe logical database on the closed existing Core PostgreSQL server. A reviewed one-create saved plan and owner apply decision are required; schema bootstrap, principals, jobs and activation remain separate. Preserve existing state inputs instead of disabling already-owned identities or grants."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.prepare_production_core_bundle_database ||
      (
        local.production_core_bundle_target_valid &&
        var.postgres_database_name == "cosmaneura_scribe" &&
        !var.deploy_postgres_foundation &&
        !var.deploy_production_existing_host_reuse &&
        !var.deploy_production_native_edge &&
        !var.deploy_database_migration_job &&
        !var.use_postgres_repository &&
        !var.deploy_container_app &&
        !var.enable_workflow_authentication &&
        !var.enable_capture_protocol &&
        !var.enable_master_platform_handoff &&
        !var.enable_production_existing_host_runtime &&
        !var.enable_production_native_direct_upload &&
        !var.enable_production_native_receiver &&
        !var.enable_production_native_encounter_creation &&
        !var.deploy_production_captured_workers &&
        !var.enable_production_captured_workers &&
        !var.enable_production_captured_database_permissions &&
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
        !var.enable_private_terraform_runner
      )
    )
    error_message = "Core bundle database preparation requires the exact existing production foundation, cosmaneura_scribe database name, and all obsolete hosting, dedicated-server, job and runtime activation gates disabled"
  }
}

locals {
  production_core_bundle_database_server_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
  production_core_bundle_database_fqdn      = "cosmaneura-prod-postgres.postgres.database.azure.com"
}
