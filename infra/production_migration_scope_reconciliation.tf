# Selected-input reconciliation only. Preserve the observed literal scope of
# the already-created migration AcrPull assignment instead of replacing it
# because the registry provider projects a different resource-ID case.
variable "retained_production_migration_registry_scope" {
  description = "Owner-selected exact live literal scope for the existing production migration AcrPull assignment. Null preserves the earlier computed selector. An explicit value is admitted only for migration preparation and the case-insensitively identical owned Scribe registry; it is not approval to import, replace or widen access. Keep the selected live value in protected inputs."
  type        = string
  default     = null

  validation {
    condition = var.retained_production_migration_registry_scope == null ? true : (
      var.prepare_production_database_migration_identity &&
      var.environment == "production" &&
      var.subscription_id == "bab2a709-1fcb-4c87-a9fc-802f7477ec13" &&
      var.resource_group_name == "cosmaneura-scribe-production" &&
      var.container_registry_name == "cosmaneurascribeprod" &&
      lower(var.retained_production_migration_registry_scope) == lower(
        "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-scribe-production/providers/Microsoft.ContainerRegistry/registries/cosmaneurascribeprod"
      )
    )
    error_message = "retained migration scope is limited to the identical owned production Scribe registry during explicit migration-identity preparation"
  }
}
