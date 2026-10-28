variable "deploy_production_native_edge" {
  description = "Create the production-only public Scribe workflow/native edge in the dedicated VNet. The workloads remain behaviorally dark until their independent gates are enabled."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.deploy_production_native_edge ||
      (
        var.environment == "production" &&
        var.deploy_container_app &&
        var.deploy_postgres_foundation &&
        var.deploy_database_migration_job &&
        var.use_postgres_repository &&
        var.enable_workflow_authentication &&
        !var.connect_parallel_platform_vnet &&
        can(regex("^[0-9a-f]{40}$", var.container_image_tag)) &&
        can(regex("^sha256:[0-9a-f]{64}$", var.container_image_digest)) &&
        can(regex("^[0-9a-f]{40}$", var.production_native_receiver_image_tag)) &&
        can(regex("^sha256:[0-9a-f]{64}$", var.production_native_receiver_image_digest)) &&
        can(regex("^[0-9a-f]{64}$", var.production_native_receiver_image_contract_sha256))
      )
    )
    error_message = "the production native edge requires production, the digest-pinned PostgreSQL workflow API and migration job, Entra workflow authentication, no obsolete VNet peering, and a digest-pinned receiver image/manifest binding"
  }
}

variable "container_image_digest" {
  description = "Immutable digest of the Scribe workflow API image; required by the production native edge."
  type        = string
  default     = "not-deployed"
}

variable "production_native_edge_subnet_address_prefixes" {
  description = "Dedicated subnet prefixes for the external production native/workflow Container Apps environment."
  type        = list(string)
  default     = ["10.42.6.0/23"]

  validation {
    condition = (
      length(var.production_native_edge_subnet_address_prefixes) == 1 &&
      can(cidrhost(var.production_native_edge_subnet_address_prefixes[0], 0)) &&
      try(tonumber(split("/", var.production_native_edge_subnet_address_prefixes[0])[1]) <= 23, false) &&
      !contains(
        concat(
          var.private_endpoint_subnet_address_prefixes,
          var.container_apps_subnet_address_prefixes,
          var.postgres_subnet_address_prefixes,
        ),
        var.production_native_edge_subnet_address_prefixes[0],
      )
    )
    error_message = "production_native_edge_subnet_address_prefixes must contain one valid /23-or-larger CIDR distinct from every existing Scribe subnet"
  }
}

variable "production_native_receiver_image_repository" {
  description = "ACR repository containing the standalone production native receiver image."
  type        = string
  default     = "cosmaneura-scribe-native-receiver"

  validation {
    condition     = can(regex("^[a-z0-9]+(?:[._/-][a-z0-9]+)*$", var.production_native_receiver_image_repository))
    error_message = "production_native_receiver_image_repository must be a lowercase ACR repository path"
  }
}

variable "production_native_receiver_image_tag" {
  description = "Exact merged Scribe source commit used to build the receiver image."
  type        = string
  default     = "not-deployed"
}

variable "production_native_receiver_image_digest" {
  description = "Immutable sha256 digest of the standalone receiver image."
  type        = string
  default     = "not-deployed"
}

variable "production_native_receiver_image_contract_sha256" {
  description = "SHA-256 of the packaged /app/provider/receiver-image-manifest.json verified by the fixed image entrypoint before it materializes configuration or starts the receiver. A hash is a binding, not approval."
  type        = string
  default     = ""
}

variable "production_native_receiver_identity_resource_id" {
  description = "Exact existing production Scribe workflow UAMI resource ID used by the native receiver to call Core and authenticate to the read-only Core registry database."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.deploy_production_native_edge ||
      (
        can(regex(
          "^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[^/]+$",
          var.production_native_receiver_identity_resource_id,
        )) &&
        startswith(
          lower(var.production_native_receiver_identity_resource_id),
          "/subscriptions/${lower(var.subscription_id)}/resourcegroups/cosmaneura-prod/",
        )
      )
    )
    error_message = "production_native_receiver_identity_resource_id must name the existing cosmaneura-prod Scribe UAMI in this subscription"
  }
}

variable "production_native_receiver_identity_client_id" {
  description = "Expected client ID for the existing production Scribe workflow UAMI; checked against Azure before a receiver revision can be planned."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.deploy_production_native_edge ||
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.production_native_receiver_identity_client_id))
    )
    error_message = "production_native_receiver_identity_client_id must be the exact existing UAMI client UUID"
  }
}

variable "production_core_registry_postgres_resource_id" {
  description = "Exact Core production PostgreSQL Flexible Server resource ID used only to create the Scribe-side private endpoint."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.deploy_production_native_edge ||
      (
        can(regex(
          "^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.DBforPostgreSQL/flexibleServers/[^/]+$",
          var.production_core_registry_postgres_resource_id,
        )) &&
        startswith(
          lower(var.production_core_registry_postgres_resource_id),
          "/subscriptions/${lower(var.subscription_id)}/resourcegroups/cosmaneura-prod/",
        )
      )
    )
    error_message = "production_core_registry_postgres_resource_id must name the existing cosmaneura-prod PostgreSQL server in this subscription"
  }
}

variable "production_native_receiver_binding" {
  description = "Non-secret, receipt-bound production receiver configuration. No token, password, patient data, audio URL, or credential belongs here."
  sensitive   = true
  type = object({
    environment_id                = string
    beta_box_id                   = string
    core_registry_database_host   = string
    core_registry_database_name   = string
    core_registry_database_role   = string
    core_scope                    = string
    audience                      = string
    organization_id               = string
    ingress_isolation_receipt     = string
    deployment_receipt_sha256     = string
    session_claims_receipt_sha256 = string
    native_policy_receipt_sha256  = string
    protected_data_receipt_sha256 = string
  })
  default = null

  validation {
    condition = (
      !var.deploy_production_native_edge ||
      (
        try(var.production_native_receiver_binding != null, false) &&
        can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", try(var.production_native_receiver_binding.environment_id, ""))) &&
        try(var.production_native_receiver_binding.environment_id, "") != "00000000-0000-0000-0000-000000000000" &&
        can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", try(var.production_native_receiver_binding.beta_box_id, ""))) &&
        try(var.production_native_receiver_binding.beta_box_id, "") != "00000000-0000-0000-0000-000000000000" &&
        can(regex("^[a-z0-9-]+\\.postgres\\.database\\.azure\\.com$", try(var.production_native_receiver_binding.core_registry_database_host, ""))) &&
        can(regex("^[A-Za-z0-9_-]{1,63}$", try(var.production_native_receiver_binding.core_registry_database_name, ""))) &&
        can(regex("^[A-Za-z0-9_-]{1,63}$", try(var.production_native_receiver_binding.core_registry_database_role, ""))) &&
        can(regex("^api://[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/\\.default$", try(var.production_native_receiver_binding.core_scope, ""))) &&
        can(regex("^[!-~]{1,255}$", try(var.production_native_receiver_binding.audience, ""))) &&
        can(regex("^org_[A-Za-z0-9_]{1,251}$", try(var.production_native_receiver_binding.organization_id, ""))) &&
        can(regex("^[A-Za-z0-9._:/-]{8,160}$", try(var.production_native_receiver_binding.ingress_isolation_receipt, ""))) &&
        can(regex("^[0-9a-f]{64}$", try(var.production_native_receiver_binding.deployment_receipt_sha256, ""))) &&
        can(regex("^[0-9a-f]{64}$", try(var.production_native_receiver_binding.session_claims_receipt_sha256, ""))) &&
        can(regex("^[0-9a-f]{64}$", try(var.production_native_receiver_binding.native_policy_receipt_sha256, ""))) &&
        can(regex("^[0-9a-f]{64}$", try(var.production_native_receiver_binding.protected_data_receipt_sha256, "")))
      )
    )
    error_message = "production_native_receiver_binding must contain exact nonzero UUIDs, Core registry/database/scope values, production audience/organization, and four lowercase SHA-256 evidence bindings"
  }
}

variable "enable_production_native_direct_upload" {
  description = "Expose only the encrypted Blob data endpoint needed for short-lived user-delegation SAS PUTs. Shared keys, local users, and anonymous Blob access remain disabled."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_production_native_direct_upload ||
      (
        var.deploy_production_native_edge &&
        can(regex("^[0-9a-f]{64}$", var.production_native_upload_policy_receipt_sha256))
      )
    )
    error_message = "production native direct upload requires the production edge and an exact reviewed upload-policy receipt"
  }
}

variable "production_native_upload_policy_receipt_sha256" {
  description = "SHA-256 of the reviewed encrypted user-delegation SAS/CORS/retention policy. A hash is a binding, not approval."
  type        = string
  default     = ""
}

variable "enable_production_native_receiver" {
  description = "Start the production native receiver only after the workflow API, capture protocol, direct encrypted upload edge, identity/database grants, and installed client are qualified."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_production_native_receiver ||
      (
        var.deploy_production_native_edge &&
        var.enable_capture_protocol &&
        var.enable_production_native_direct_upload
      )
    )
    error_message = "enabling the production native receiver requires the deployed edge, authenticated PostgreSQL capture protocol, and reviewed direct encrypted upload edge"
  }
}

variable "enable_production_native_encounter_creation" {
  description = "Allow the enabled production receiver to create repeatable encounters only after that separate Core workflow has qualified."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_production_native_encounter_creation || var.enable_production_native_receiver
    error_message = "production encounter creation requires the production native receiver to be enabled"
  }
}

locals {
  production_native_receiver_name   = "cosmaneura-scribe-${local.environment_short}-native"
  production_native_edge_name       = "${local.name_prefix}-native-edge-environment"
  production_native_edge_managed_rg = "${local.name_prefix}-native-edge-managed"
  production_native_receiver_origin = (
    var.deploy_production_native_edge
    ? "https://${local.production_native_receiver_name}.${azurerm_container_app_environment.production_native_edge[0].default_domain}"
    : "https://disabled.invalid"
  )
  production_workflow_api_origin = (
    var.deploy_production_native_edge
    ? "https://${local.container_app_name}.${azurerm_container_app_environment.production_native_edge[0].default_domain}"
    : "https://disabled.invalid"
  )
  application_image = (
    var.deploy_production_native_edge
    ? "${azurerm_container_registry.scribe.login_server}/${var.container_image_repository}@${var.container_image_digest}"
    : "${azurerm_container_registry.scribe.login_server}/${var.container_image_repository}:${var.container_image_tag}"
  )
  production_native_receiver_identity_parts = split(
    "/",
    trimprefix(var.production_native_receiver_identity_resource_id, "/"),
  )
  production_native_receiver_identity_resource_group = try(
    local.production_native_receiver_identity_parts[3],
    "disabled",
  )
  production_native_receiver_identity_name = try(
    local.production_native_receiver_identity_parts[7],
    "disabled",
  )
  production_native_receiver_configuration = var.deploy_production_native_edge ? {
    schema                                = 1
    enabled                               = var.enable_production_native_receiver
    encounter_creation_enabled            = var.enable_production_native_encounter_creation
    platforms                             = ["ios", "desktop"]
    desktop_native_session_without_origin = false
    environment_id                        = var.production_native_receiver_binding.environment_id
    beta_box_id                           = var.production_native_receiver_binding.beta_box_id
    managed_identity_client_id            = var.production_native_receiver_identity_client_id
    database_host                         = var.production_native_receiver_binding.core_registry_database_host
    database_name                         = var.production_native_receiver_binding.core_registry_database_name
    database_reader_role                  = var.production_native_receiver_binding.core_registry_database_role
    core_scope                            = var.production_native_receiver_binding.core_scope
    ingress_isolation_receipt             = var.production_native_receiver_binding.ingress_isolation_receipt
    profile                               = "core-production-organization-v1"
    production = {
      core_origin                   = "https://app.cosmaneura.com"
      issuer                        = "https://clerk.cosmaneura.com"
      receiver_origin               = local.production_native_receiver_origin
      audience                      = var.production_native_receiver_binding.audience
      organization_id               = var.production_native_receiver_binding.organization_id
      deployment_receipt_sha256     = var.production_native_receiver_binding.deployment_receipt_sha256
      session_claims_receipt_sha256 = var.production_native_receiver_binding.session_claims_receipt_sha256
      native_policy_receipt_sha256  = var.production_native_receiver_binding.native_policy_receipt_sha256
      protected_data_receipt_sha256 = var.production_native_receiver_binding.protected_data_receipt_sha256
    }
  } : null
}

data "azurerm_user_assigned_identity" "production_native_receiver" {
  count = var.deploy_production_native_edge ? 1 : 0

  name                = local.production_native_receiver_identity_name
  resource_group_name = local.production_native_receiver_identity_resource_group
}

resource "azurerm_subnet" "production_native_edge" {
  count = var.deploy_production_native_edge ? 1 : 0

  name                 = "production-native-edge"
  resource_group_name  = local.resource_group_name
  virtual_network_name = azurerm_virtual_network.scribe.name
  address_prefixes     = var.production_native_edge_subnet_address_prefixes

  delegation {
    name = "Microsoft.App.environments"

    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_container_app_environment" "production_native_edge" {
  count = var.deploy_production_native_edge ? 1 : 0

  name                = local.production_native_edge_name
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

  infrastructure_resource_group_name = local.production_native_edge_managed_rg
  infrastructure_subnet_id           = azurerm_subnet.production_native_edge[0].id
  internal_load_balancer_enabled     = false
  log_analytics_workspace_id         = azurerm_log_analytics_workspace.scribe.id
  logs_destination                   = "log-analytics"
  public_network_access              = "Enabled"
  zone_redundancy_enabled            = false

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  depends_on = [
    azurerm_subnet_network_security_group_association.production_native_edge,
  ]

  tags = local.tags
}

resource "azurerm_private_dns_zone" "core_registry_postgres" {
  count = var.deploy_production_native_edge ? 1 : 0

  name                = "privatelink.postgres.database.azure.com"
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "core_registry_postgres" {
  count = var.deploy_production_native_edge ? 1 : 0

  name                  = "${local.name_prefix}-core-registry-postgres-link"
  resource_group_name   = local.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.core_registry_postgres[0].name
  virtual_network_id    = azurerm_virtual_network.scribe.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "core_registry_postgres" {
  count = var.deploy_production_native_edge ? 1 : 0

  name                = "${local.name_prefix}-core-registry-postgres-pe"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  subnet_id           = azurerm_subnet.private_endpoints.id

  private_service_connection {
    name                           = "${local.name_prefix}-core-registry-postgres-connection"
    private_connection_resource_id = var.production_core_registry_postgres_resource_id
    is_manual_connection           = false
    subresource_names              = ["postgresqlServer"]
  }

  private_dns_zone_group {
    name                 = "postgres"
    private_dns_zone_ids = [azurerm_private_dns_zone.core_registry_postgres[0].id]
  }

  depends_on = [
    azurerm_private_dns_zone_virtual_network_link.core_registry_postgres,
    azurerm_subnet_network_security_group_association.private_endpoints,
  ]

  tags = local.tags
}

resource "azurerm_role_assignment" "production_native_receiver_acr" {
  count = var.deploy_production_native_edge ? 1 : 0

  scope                            = azurerm_container_registry.scribe.id
  role_definition_id               = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d"
  principal_id                     = data.azurerm_user_assigned_identity.production_native_receiver[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app" "production_native_receiver" {
  count = var.deploy_production_native_edge ? 1 : 0

  name                         = local.production_native_receiver_name
  resource_group_name          = local.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.production_native_edge[0].id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  max_inactive_revisions       = 3

  identity {
    type = "UserAssigned"
    identity_ids = [
      data.azurerm_user_assigned_identity.production_native_receiver[0].id,
    ]
  }

  registry {
    server   = azurerm_container_registry.scribe.login_server
    identity = data.azurerm_user_assigned_identity.production_native_receiver[0].id
  }

  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 8080
    transport                  = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas                     = var.enable_production_native_receiver ? 1 : 0
    max_replicas                     = 2
    termination_grace_period_seconds = 30

    container {
      name   = "native-receiver"
      image  = "${azurerm_container_registry.scribe.login_server}/${var.production_native_receiver_image_repository}@${var.production_native_receiver_image_digest}"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"
        value = jsonencode(local.production_native_receiver_configuration)
      }

      env {
        name  = "COSMANEURA_SCRIBE_PROVIDER_IMAGE_CONTRACT_SHA256"
        value = var.production_native_receiver_image_contract_sha256
      }

      liveness_probe {
        transport        = "TCP"
        port             = 8080
        initial_delay    = 10
        interval_seconds = 30
        timeout          = 5
      }

      readiness_probe {
        transport               = "TCP"
        port                    = 8080
        initial_delay           = 5
        interval_seconds        = 10
        timeout                 = 5
        success_count_threshold = 1
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "20"
    }
  }

  lifecycle {
    precondition {
      condition = (
        lower(data.azurerm_user_assigned_identity.production_native_receiver[0].id) ==
        lower(var.production_native_receiver_identity_resource_id)
      )
      error_message = "the resolved native receiver identity must exactly match production_native_receiver_identity_resource_id"
    }

    precondition {
      condition = (
        lower(data.azurerm_user_assigned_identity.production_native_receiver[0].client_id) ==
        lower(var.production_native_receiver_identity_client_id)
      )
      error_message = "the resolved native receiver identity client ID must match the reviewed production binding"
    }
  }

  depends_on = [
    azurerm_private_endpoint.core_registry_postgres,
    azurerm_role_assignment.production_native_receiver_acr,
  ]

  tags = merge(local.tags, {
    image_source_commit = var.production_native_receiver_image_tag
  })
}

output "production_native_receiver_origin" {
  description = "Exact public system-trust origin to seal into reviewed production native clients; null while the edge is absent."
  value       = var.deploy_production_native_edge ? local.production_native_receiver_origin : null
}

output "production_workflow_api_origin" {
  description = "Exact Entra-protected public workflow API origin for Core; null while the edge is absent."
  value       = var.deploy_production_native_edge ? local.production_workflow_api_origin : null
}

output "production_native_upload_origin" {
  description = "Exact encrypted user-delegation-SAS Blob origin; null while direct upload is closed."
  value = (
    var.enable_production_native_direct_upload
    ? trimsuffix(azurerm_storage_account.audio.primary_blob_endpoint, "/")
    : null
  )
}
