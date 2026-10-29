variable "prepare_production_existing_host_runtime_network" {
  description = "Separately prepare exact-Core-egress public-key reads and authenticated public ciphertext uploads. This changes neither worker private custody nor capture activation, and requires its own reviewed plan/apply."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.prepare_production_existing_host_runtime_network ||
      (var.environment == "production" && !var.deploy_production_native_edge && var.enable_production_arm_audio_key_bootstrap && can(regex("^[0-9a-f]{64}$", var.production_existing_host_network_policy_receipt_sha256)))
    )
    error_message = "existing-host network preparation requires production ARM key custody, the separately reviewed encrypted upload policy and exact-egress network receipt"
  }
}

variable "production_existing_host_network_policy_receipt_sha256" {
  description = "Hash of the independently reviewed exact-Core-IP key Reader/private-worker/public-ciphertext network policy. A hash is not approval."
  type        = string
  default     = ""
}

variable "enable_production_existing_host_runtime" {
  description = "Enable the existing-host configured-capture API only after the paired receiver/client, database-role, private-worker and bounded-network qualification. Founder owns the cohort and activation."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_production_existing_host_runtime ||
      (var.deploy_production_existing_host_reuse && var.prepare_production_existing_host_runtime_network && var.enable_capture_protocol && var.enable_production_captured_workers && can(regex("^[0-9a-f]{64}$", var.production_existing_host_runtime_qualification_receipt_sha256)))
    )
    error_message = "configured capture activation requires exact existing-host placement, bounded network, live private workers and completed paired native/database qualification"
  }
}

variable "production_existing_host_runtime_qualification_receipt_sha256" {
  description = "Binding to completed production native/session/database/private-path qualification for the exact capture cohort, never a fabricated attestation."
  type        = string
  default     = ""
}

# The shared environment's ingress/static IP is not its outbound IP. Read the
# actual Core app and, at activation, the already-dark Scribe app. No app is
# adopted or changed by these metadata-only GETs.
data "azapi_resource" "production_core_app_egress" {
  count                  = var.prepare_production_existing_host_runtime_network ? 1 : 0
  type                   = "Microsoft.App/containerApps@2024-03-01"
  resource_id            = "/subscriptions/${var.subscription_id}/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
  response_export_values = ["properties.environmentId", "properties.outboundIpAddresses"]

  lifecycle {
    postcondition {
      condition = try(
        lower(self.output.properties.environmentId) == lower(var.production_existing_hosting_binding.container_app_environment_id) &&
        one(self.output.properties.outboundIpAddresses) == var.production_existing_hosting_binding.container_apps_outbound_ipv4,
        false,
      )
      error_message = "the live Core app must still use the exact reviewed environment and single outbound IP; ingress/static IP is not accepted as egress"
    }
  }
}

data "azapi_resource" "production_scribe_api_egress" {
  count                  = var.enable_production_existing_host_runtime ? 1 : 0
  type                   = "Microsoft.App/containerApps@2024-03-01"
  resource_id            = "/subscriptions/${var.subscription_id}/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/${local.container_app_name}"
  response_export_values = ["properties.environmentId", "properties.outboundIpAddresses"]

  lifecycle {
    postcondition {
      condition = try(
        lower(self.output.properties.environmentId) == lower(var.production_existing_hosting_binding.container_app_environment_id) &&
        one(self.output.properties.outboundIpAddresses) == var.production_existing_hosting_binding.container_apps_outbound_ipv4,
        false,
      )
      error_message = "activation requires an already-deployed dark Scribe API whose actual outbound IP matches the single reviewed Key Vault allowlist"
    }
  }
}

locals {
  production_existing_host_network_contract_valid = (
    !var.prepare_production_existing_host_runtime_network || var.enable_production_native_direct_upload
  )
  production_existing_host_runtime_contract_valid = (
    !var.enable_production_existing_host_runtime ||
    (local.production_database_authentication_valid && var.enable_production_captured_workers && var.production_capture_tenant_id != "")
  )
}
