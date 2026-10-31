output "resource_group_name" {
  value = local.resource_group_name
}

output "storage_account_url" {
  value = azurerm_storage_account.audio.primary_blob_endpoint
}

output "audio_container_name" {
  value = azurerm_storage_container.audio.name
}

output "key_vault_uri" {
  value = azurerm_key_vault.scribe.vault_uri
}

output "audio_encryption_key_id" {
  description = "Versionless data-plane ID of the RSA-3072 session-key wrapping key."
  value       = local.audio_key_versionless_id
}

output "runtime_managed_identity_client_id" {
  value = azurerm_user_assigned_identity.runtime.client_id
}

output "runtime_managed_identity_id" {
  value = azurerm_user_assigned_identity.runtime.id
}

output "virtual_network_id" {
  value = azurerm_virtual_network.scribe.id
}

output "private_endpoint_subnet_id" {
  value = azurerm_subnet.private_endpoints.id
}

output "container_registry_login_server" {
  value = azurerm_container_registry.scribe.login_server
}

output "container_apps_environment_id" {
  value = azurerm_container_app_environment.scribe.id
}

output "container_apps_environment_default_domain" {
  value = azurerm_container_app_environment.scribe.default_domain
}

output "container_app_fqdn" {
  value = var.deploy_container_app ? azurerm_container_app.api[0].latest_revision_fqdn : null
}

output "parallel_platform_peering_id" {
  description = "Scribe-owned side of the optional platform VNet peering."
  value       = var.connect_parallel_platform_vnet ? azurerm_virtual_network_peering.scribe_to_parallel_platform[0].id : null
}

output "parallel_platform_private_dns_link_id" {
  description = "Link that makes the private Scribe Container Apps zone resolvable from the platform VNet."
  value       = var.connect_parallel_platform_vnet ? azurerm_private_dns_zone_virtual_network_link.parallel_platform_container_apps[0].id : null
}

output "postgres_fqdn" {
  value = local.production_database_enabled || var.prepare_production_core_bundle_database ? local.production_database_fqdn : null
}

output "postgres_database_name" {
  value = local.production_database_enabled || var.prepare_production_core_bundle_database ? azurerm_postgresql_flexible_server_database.scribe[0].name : null
}

output "production_workload_hosting_mode" {
  description = "Production workload placement selected by reviewed configuration; null while production workloads are absent."
  value = local.production_workloads_enabled ? (
    var.deploy_production_existing_host_reuse ? "existing-core-host" : "dedicated-native-edge"
  ) : null
}

output "database_migration_job_name" {
  value = var.deploy_database_migration_job ? azurerm_container_app_job.database_migrations[0].name : null
}

output "transcription_job_name" {
  value = var.deploy_transcription_job ? azurerm_container_app_job.transcription[0].name : null
}

output "transcription_managed_identity_client_id" {
  value = var.deploy_transcription_job ? azurerm_user_assigned_identity.transcription[0].client_id : null
}

output "transcription_managed_identity_principal_id" {
  description = "Entra object ID used by PostgreSQL bootstrap and data-plane role assignments."
  value       = var.deploy_transcription_job ? azurerm_user_assigned_identity.transcription[0].principal_id : null
}

output "transcription_managed_identity_name" {
  value = var.deploy_transcription_job ? azurerm_user_assigned_identity.transcription[0].name : null
}

output "transcription_managed_identity_id" {
  value = var.deploy_transcription_job ? azurerm_user_assigned_identity.transcription[0].id : null
}

output "speech_account_endpoint" {
  value = var.deploy_private_speech_foundation ? azurerm_cognitive_account.speech[0].endpoint : null
}

output "speech_private_endpoint_ip" {
  value = var.deploy_private_speech_foundation ? azurerm_private_endpoint.speech[0].private_service_connection[0].private_ip_address : null
}

output "speech_smoke_job_name" {
  value = var.deploy_speech_smoke_job ? azurerm_container_app_job.speech_smoke[0].name : null
}

output "speech_smoke_managed_identity_client_id" {
  value = var.deploy_speech_smoke_job ? azurerm_user_assigned_identity.speech_smoke[0].client_id : null
}

output "development_budget_id" {
  description = "Approved development resource-group budget when its explicit notification gate is enabled."
  value       = var.enable_development_cost_guardrails ? azurerm_consumption_budget_resource_group.development[0].id : null
}

output "private_terraform_runner_identity_client_id" {
  description = "Temporary private Terraform runner client ID; null after required teardown."
  value       = var.deploy_private_terraform_runner ? azurerm_user_assigned_identity.private_terraform_runner[0].client_id : null
}

output "private_terraform_runner_identity_principal_id" {
  description = "Temporary principal used to audit and revoke every runner assignment."
  value       = var.deploy_private_terraform_runner ? azurerm_user_assigned_identity.private_terraform_runner[0].principal_id : null
}

output "private_terraform_runner_job_names" {
  description = "Fixed manual plan/apply job names; no caller start permission is created by this configuration."
  value = var.deploy_private_terraform_runner ? {
    for action, job in azurerm_container_app_job.private_terraform_runner :
    action => job.name
  } : {}
}
