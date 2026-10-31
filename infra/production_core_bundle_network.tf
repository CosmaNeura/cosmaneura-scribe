# Routing for the selected three existing Core hosts. Hashes bind separately
# reviewed policies; neither a hash nor a selector is founder authorization.
variable "prepare_production_core_bundle_network" {
  description = "Prepare existing Key Vault public TLS access for the exact Core egress, including worker unwrap. Separate founder policy and network-only plan/apply approval remain required."
  type        = bool
  default     = false
}

variable "enable_production_core_bundle_native_ciphertext_upload" {
  description = "Prepare authenticated public Blob TLS reachability and native CORS for direct ciphertext uploads. This is not anonymous access, capture activation or proof of a qualified native cohort."
  type        = bool
  default     = false
}

variable "production_core_bundle_network_policy_receipt_sha256" {
  description = "Exact independently reviewed Core-egress API JWK and worker-unwrap routing policy receipt; its hash confers no approval."
  type        = string
  default     = ""
}

variable "production_core_bundle_upload_policy_receipt_sha256" {
  description = "Exact independently reviewed public authenticated native-ciphertext upload policy receipt; its hash confers no approval."
  type        = string
  default     = ""
}

variable "production_core_bundle_hosting_binding" {
  description = "Non-secret exact existing environment, three host IDs and observed single egress. Live metadata is rechecked; this binding is not deployment authority."
  type = object({
    container_app_environment_id = string
    container_app_resource_ids   = map(string)
    container_apps_outbound_ipv4 = string
  })
  default = null
}

locals {
  production_core_bundle_environment_id = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment"
  production_core_bundle_host_ids = {
    api       = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-app"
    worker    = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-worker"
    scheduler = "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/containerApps/cosmaneura-prod-scheduler"
  }
  production_core_bundle_outbound_ipv4 = "64.236.176.41"
  production_core_bundle_hosting_binding_valid = try(
    lower(var.production_core_bundle_hosting_binding.container_app_environment_id) == lower(local.production_core_bundle_environment_id) &&
    toset(keys(var.production_core_bundle_hosting_binding.container_app_resource_ids)) == toset(keys(local.production_core_bundle_host_ids)) &&
    alltrue([for stage, id in local.production_core_bundle_host_ids : lower(var.production_core_bundle_hosting_binding.container_app_resource_ids[stage]) == lower(id)]) &&
    var.production_core_bundle_hosting_binding.container_apps_outbound_ipv4 == local.production_core_bundle_outbound_ipv4,
    false,
  )
  production_core_bundle_network_contract_valid = (
    (!var.prepare_production_core_bundle_network && !var.enable_production_core_bundle_native_ciphertext_upload) ||
    (
      var.prepare_production_core_bundle_network &&
      var.enable_production_core_bundle_native_ciphertext_upload &&
      local.production_core_bundle_target_valid &&
      local.production_core_bundle_dormant_topology_valid &&
      var.prepare_production_core_bundle_grants &&
      var.remove_owned_production_translation_blob_writer &&
      local.production_core_bundle_hosting_binding_valid &&
      can(regex("^[0-9a-f]{64}$", var.production_core_bundle_network_policy_receipt_sha256)) &&
      can(regex("^[0-9a-f]{64}$", var.production_core_bundle_upload_policy_receipt_sha256))
    )
  )
}

# Read all three existing hosts, not ingress/static IP or an unselected Scribe
# app. This adds no Azure resource and exports no environment/secret values.
data "azapi_resource" "production_core_bundle_api_egress" {
  count                  = var.prepare_production_core_bundle_network && local.production_core_bundle_network_contract_valid ? 1 : 0
  type                   = "Microsoft.App/containerApps@2024-03-01"
  resource_id            = local.production_core_bundle_host_ids.api
  response_export_values = ["id", "properties.environmentId", "properties.managedEnvironmentId", "properties.outboundIpAddresses"]

  lifecycle {
    postcondition {
      condition = try(
        lower(self.output.id) == lower(local.production_core_bundle_host_ids.api) &&
        lower(coalesce(try(self.output.properties.environmentId, null), try(self.output.properties.managedEnvironmentId, null))) == lower(local.production_core_bundle_environment_id) &&
        one(self.output.properties.outboundIpAddresses) == local.production_core_bundle_outbound_ipv4,
        false,
      )
      error_message = "the existing Core api host must still match the exact reviewed resource, environment and single egress; ingress/static IP and changed hosts are not accepted"
    }
  }
}

data "azapi_resource" "production_core_bundle_worker_egress" {
  count                  = var.prepare_production_core_bundle_network && local.production_core_bundle_network_contract_valid ? 1 : 0
  type                   = "Microsoft.App/containerApps@2024-03-01"
  resource_id            = local.production_core_bundle_host_ids.worker
  response_export_values = ["id", "properties.environmentId", "properties.managedEnvironmentId", "properties.outboundIpAddresses"]

  lifecycle {
    postcondition {
      condition = try(
        lower(self.output.id) == lower(local.production_core_bundle_host_ids.worker) &&
        lower(coalesce(try(self.output.properties.environmentId, null), try(self.output.properties.managedEnvironmentId, null))) == lower(local.production_core_bundle_environment_id) &&
        one(self.output.properties.outboundIpAddresses) == local.production_core_bundle_outbound_ipv4,
        false,
      )
      error_message = "the existing Core worker host must still match the exact reviewed resource, environment and single egress; ingress/static IP and changed hosts are not accepted"
    }
  }
}

data "azapi_resource" "production_core_bundle_scheduler_egress" {
  count                  = var.prepare_production_core_bundle_network && local.production_core_bundle_network_contract_valid ? 1 : 0
  type                   = "Microsoft.App/containerApps@2024-03-01"
  resource_id            = local.production_core_bundle_host_ids.scheduler
  response_export_values = ["id", "properties.environmentId", "properties.managedEnvironmentId", "properties.outboundIpAddresses"]

  lifecycle {
    postcondition {
      condition = try(
        lower(self.output.id) == lower(local.production_core_bundle_host_ids.scheduler) &&
        lower(coalesce(try(self.output.properties.environmentId, null), try(self.output.properties.managedEnvironmentId, null))) == lower(local.production_core_bundle_environment_id) &&
        one(self.output.properties.outboundIpAddresses) == local.production_core_bundle_outbound_ipv4,
        false,
      )
      error_message = "the existing Core scheduler host must still match the exact reviewed resource, environment and single egress; ingress/static IP and changed hosts are not accepted"
    }
  }
}

