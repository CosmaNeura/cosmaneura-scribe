# IAM preparation for the selected three existing Core hosts only. This does
# not attach identities, open networks, bootstrap a key, or activate workloads.
variable "prepare_production_core_bundle_grants" {
  description = "Prepare narrowly scoped grants for the selected existing Core API/Speech/translation identities. Owner policy/grant approval and a reviewed IAM-only plan/apply remain required; this is not readiness or activation."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.prepare_production_core_bundle_grants ||
      (
        local.production_core_bundle_target_valid &&
        local.production_core_bundle_dormant_topology_valid &&
        var.remove_owned_production_translation_blob_writer
      )
    )
    error_message = "Core bundle grant preparation requires the exact existing production foundation, explicit owned translation-writer removal, and all topology, database, network and activation gates disabled"
  }
}

variable "remove_owned_production_translation_blob_writer" {
  description = "Explicitly select removal of only this state's runtime_audio account-wide Blob Data Contributor assignment before translation identity attachment. False preserves it. This source choice is not proof of completed cleanup; never restore the broad writer as automatic recovery."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.remove_owned_production_translation_blob_writer ||
      (local.production_core_bundle_target_valid && local.production_core_bundle_dormant_topology_valid)
    )
    error_message = "owned translation writer removal is limited to the exact production foundation with topology, network, database and activation gates disabled"
  }
}

locals {
  production_core_bundle_target_valid = (
    var.environment == "production" &&
    var.subscription_id == "bab2a709-1fcb-4c87-a9fc-802f7477ec13" &&
    var.resource_group_name == "cosmaneura-scribe-production" &&
    var.storage_account_name == "cosmaneurascribeprod" &&
    var.key_vault_name == "cosmaneura-scribe-prod" &&
    !var.create_resource_group
  )
  production_core_bundle_dormant_topology_valid = (
    !var.prepare_production_database_migration_identity &&
    !var.deploy_production_existing_host_reuse &&
    !var.deploy_production_native_edge &&
    !var.deploy_postgres_foundation &&
    !var.deploy_database_migration_job &&
    !var.use_postgres_repository &&
    !var.deploy_container_app &&
    !var.enable_workflow_authentication &&
    !var.enable_capture_protocol &&
    !var.enable_master_platform_handoff &&
    !var.prepare_production_existing_host_runtime_network &&
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
    !var.enable_private_terraform_runner &&
    !var.connect_parallel_platform_vnet
  )
  production_core_bundle_identities = {
    api = {
      resource_group_name = "cosmaneura-prod"
      name                = "cosmaneura-prod-scribe-workflow"
      client_id           = "c7bae168-fbf5-4658-b0d9-dd4b5373a1be"
      principal_id        = "8fecefc9-1577-4afa-b353-83beb5f793f7"
    }
    speech = {
      resource_group_name = "cosmaneura-prod"
      name                = "cosmaneura-prod-health-services"
      client_id           = "5696041c-ee89-4ef5-bc5d-fdf846cd7364"
      principal_id        = "36cc13e3-293b-45a6-9819-4cee01458de6"
    }
    translation = {
      resource_group_name = "cosmaneura-scribe-production"
      name                = "cosmaneura-scribe-production-runtime"
      client_id           = "39d00a14-ca79-4cbf-8821-3e2af90ea0e2"
      principal_id        = "3f712a80-f393-49d0-ab42-6a40bc50dfbd"
    }
  }
  production_core_audio_container_scope = "${azurerm_storage_account.audio.id}/blobServices/default/containers/${local.audio_container_name}"
}

# Read existing identities; never create/adopt a Core host or identity here.
data "azurerm_user_assigned_identity" "production_core_bundle_api" {
  count               = var.prepare_production_core_bundle_grants ? 1 : 0
  name                = local.production_core_bundle_identities.api.name
  resource_group_name = local.production_core_bundle_identities.api.resource_group_name

  lifecycle {
    postcondition {
      condition = (
        lower(self.id) == lower("/subscriptions/${var.subscription_id}/resourceGroups/${local.production_core_bundle_identities.api.resource_group_name}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${local.production_core_bundle_identities.api.name}") &&
        lower(self.client_id) == local.production_core_bundle_identities.api.client_id &&
        lower(self.principal_id) == local.production_core_bundle_identities.api.principal_id
      )
      error_message = "existing api resource/client/principal must match the closed runtime; translation must remain the existing Terraform-owned foundation identity"
    }
  }
}

data "azurerm_user_assigned_identity" "production_core_bundle_speech" {
  count               = var.prepare_production_core_bundle_grants ? 1 : 0
  name                = local.production_core_bundle_identities.speech.name
  resource_group_name = local.production_core_bundle_identities.speech.resource_group_name

  lifecycle {
    postcondition {
      condition = (
        lower(self.id) == lower("/subscriptions/${var.subscription_id}/resourceGroups/${local.production_core_bundle_identities.speech.resource_group_name}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${local.production_core_bundle_identities.speech.name}") &&
        lower(self.client_id) == local.production_core_bundle_identities.speech.client_id &&
        lower(self.principal_id) == local.production_core_bundle_identities.speech.principal_id
      )
      error_message = "existing speech resource/client/principal must match the closed runtime; translation must remain the existing Terraform-owned foundation identity"
    }
  }
}

data "azurerm_user_assigned_identity" "production_core_bundle_translation" {
  count               = var.prepare_production_core_bundle_grants ? 1 : 0
  name                = local.production_core_bundle_identities.translation.name
  resource_group_name = local.production_core_bundle_identities.translation.resource_group_name

  lifecycle {
    postcondition {
      condition = (
        lower(self.id) == lower("/subscriptions/${var.subscription_id}/resourceGroups/${local.production_core_bundle_identities.translation.resource_group_name}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${local.production_core_bundle_identities.translation.name}") &&
        lower(self.client_id) == local.production_core_bundle_identities.translation.client_id &&
        lower(self.principal_id) == local.production_core_bundle_identities.translation.principal_id
      )
      error_message = "existing translation resource/client/principal must match the closed runtime; translation must remain the existing Terraform-owned foundation identity"
    }
  }
}

locals {
  production_core_bundle_identity_metadata = var.prepare_production_core_bundle_grants ? {
    api         = data.azurerm_user_assigned_identity.production_core_bundle_api[0]
    speech      = data.azurerm_user_assigned_identity.production_core_bundle_speech[0]
    translation = data.azurerm_user_assigned_identity.production_core_bundle_translation[0]
  } : {}
}

resource "azurerm_role_assignment" "production_core_bundle_key" {
  for_each = local.production_core_bundle_identity_metadata
  scope    = local.audio_key_versionless_resource_id
  # API only reads the public JWK. The two worker stages GET and unwrap.
  role_definition_id               = each.key == "api" ? "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/21090545-7ca7-4776-b22c-e363652d74d2" : null
  role_definition_name             = each.key == "api" ? null : "Key Vault Crypto User"
  principal_id                     = each.value.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
  depends_on                       = [azurerm_key_vault_key.audio, azapi_resource.production_audio_key]
}

resource "azurerm_role_assignment" "production_core_bundle_api_delegator" {
  count                            = var.prepare_production_core_bundle_grants ? 1 : 0
  scope                            = azurerm_storage_account.audio.id
  role_definition_name             = "Storage Blob Delegator"
  principal_id                     = data.azurerm_user_assigned_identity.production_core_bundle_api[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# SAS permissions intersect the delegating identity's RBAC. The existing API
# issues create/write SAS; it needs neither Blob read/delete nor key unwrap.
resource "azurerm_role_definition" "production_core_bundle_audio_upload" {
  count              = var.prepare_production_core_bundle_grants ? 1 : 0
  role_definition_id = "71a6b02f-294d-5734-8721-007ff54f4f67"
  name               = "Cosmaneura Scribe Core Audio Upload Writer"
  scope              = local.resource_group_id
  description        = "Create/write encrypted Scribe audio through the API's bounded user-delegation SAS; no Blob read/delete or account management."

  permissions {
    actions          = []
    not_actions      = []
    data_actions     = ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write"]
    not_data_actions = []
  }
  assignable_scopes = [local.resource_group_id]
}

resource "azurerm_role_assignment" "production_core_bundle_api_audio_upload" {
  count                            = var.prepare_production_core_bundle_grants ? 1 : 0
  scope                            = local.production_core_audio_container_scope
  role_definition_id               = azurerm_role_definition.production_core_bundle_audio_upload[0].role_definition_resource_id
  principal_id                     = data.azurerm_user_assigned_identity.production_core_bundle_api[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "production_core_bundle_speech_audio_reader" {
  count                            = var.prepare_production_core_bundle_grants ? 1 : 0
  scope                            = local.production_core_audio_container_scope
  role_definition_name             = "Storage Blob Data Reader"
  principal_id                     = data.azurerm_user_assigned_identity.production_core_bundle_speech[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "production_core_bundle_ai" {
  for_each = var.prepare_production_core_bundle_grants ? toset(["speech", "translation"]) : toset([])
  scope    = local.production_ai_id
  # Translation storage_backend=memory: deliberately no translation Blob grant.
  role_definition_name             = each.key == "speech" ? "Cognitive Services Speech User" : "Cognitive Services OpenAI User"
  principal_id                     = local.production_core_bundle_identity_metadata[each.key].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}
