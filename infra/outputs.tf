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
  value       = azurerm_key_vault_key.audio.versionless_id
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
  value = var.deploy_postgres_foundation ? azurerm_postgresql_flexible_server.scribe[0].fqdn : null
}

output "postgres_database_name" {
  value = var.deploy_postgres_foundation ? azurerm_postgresql_flexible_server_database.scribe[0].name : null
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
