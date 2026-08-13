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
