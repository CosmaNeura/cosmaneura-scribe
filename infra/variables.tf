variable "subscription_id" {
  description = "Azure subscription containing the development environment."
  type        = string
}

variable "tenant_id" {
  description = "Microsoft Entra tenant ID."
  type        = string
}

variable "environment" {
  description = "Short environment name."
  type        = string
  default     = "development"

  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment must be development, staging, or production"
  }
}

variable "location" {
  description = "Azure region for PHI data residency."
  type        = string
  default     = "eastus"
}

variable "resource_group_name" {
  description = "Dedicated resource group for scribe resources."
  type        = string
}

variable "create_resource_group" {
  description = "Create the resource group; false connects to an existing one."
  type        = bool
  default     = false
}

variable "storage_account_name" {
  description = "Globally unique lowercase storage account name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "storage_account_name must contain 3-24 lowercase letters or numbers"
  }
}

variable "key_vault_name" {
  description = "Globally unique Key Vault name."
  type        = string
}

variable "virtual_network_address_space" {
  description = "Dedicated scribe development VNet address space."
  type        = list(string)
  default     = ["10.42.0.0/16"]
}

variable "private_endpoint_subnet_address_prefixes" {
  description = "Address prefixes for the subnet that hosts scribe private endpoints."
  type        = list(string)
  default     = ["10.42.1.0/24"]
}

variable "container_apps_subnet_address_prefixes" {
  description = "Dedicated address prefixes for the Container Apps workload-profile environment."
  type        = list(string)
  default     = ["10.42.2.0/23"]
}

variable "postgres_subnet_address_prefixes" {
  description = "Dedicated address prefixes for PostgreSQL Flexible Server VNet integration."
  type        = list(string)
  default     = ["10.42.4.0/24"]
}

variable "container_registry_name" {
  description = "Globally unique Azure Container Registry name."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9]{5,50}$", var.container_registry_name))
    error_message = "container_registry_name must contain 5-50 alphanumeric characters"
  }
}

variable "enable_phi_safe_data_plane_diagnostics" {
  description = "Enable Blob and Key Vault audit diagnostics only after cost alerts and the reviewed Log Analytics baseline are active."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_phi_safe_data_plane_diagnostics ||
      (
        var.enable_development_cost_guardrails &&
        var.enable_log_analytics_audit_baseline
      )
    )
    error_message = "enable_phi_safe_data_plane_diagnostics requires the development budget alerts and reviewed Log Analytics baseline"
  }
}

variable "enable_development_cost_guardrails" {
  description = "Create the approved development resource-group budget and its actual/forecast notifications."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_development_cost_guardrails || var.environment == "development"
    error_message = "the approved $100 cost guardrail in this slice is development-only"
  }
}

variable "development_monthly_budget_usd" {
  description = "Approved monthly development resource-group budget in USD."
  type        = number
  default     = 100

  validation {
    condition     = var.development_monthly_budget_usd == 100
    error_message = "development_monthly_budget_usd is pinned to the approved $100 threshold"
  }
}

variable "development_budget_start_date" {
  description = "First UTC day of the month when the approved development budget begins."
  type        = string
  default     = "2026-08-01T00:00:00Z"

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-01T00:00:00Z$", var.development_budget_start_date))
    error_message = "development_budget_start_date must be the first UTC day of a month in RFC3339 form"
  }
}

variable "development_budget_notification_action_group_ids" {
  description = "Existing enabled Azure Monitor action groups for the 80% actual and forecast development budget alerts."
  type        = set(string)
  default     = []

  validation {
    condition = (
      !var.enable_development_cost_guardrails ||
      (
        length(var.development_budget_notification_action_group_ids) > 0 &&
        alltrue([
          for action_group_id in var.development_budget_notification_action_group_ids :
          can(regex(
            "^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/[Mm]icrosoft\\.[Ii]nsights/actionGroups/[^/]+$",
            action_group_id,
          ))
        ])
      )
    )
    error_message = "enabling development cost guardrails requires at least one explicit Azure Monitor action-group resource ID"
  }
}

variable "enable_log_analytics_audit_baseline" {
  description = "Activate the reviewed 90-day, uncapped operational workspace only after development cost guardrails are active."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_log_analytics_audit_baseline ||
      var.enable_development_cost_guardrails
    )
    error_message = "enable_log_analytics_audit_baseline requires enable_development_cost_guardrails=true"
  }
}

variable "log_analytics_retention_in_days" {
  description = "Operational Log Analytics retention; 30 days while staged, exactly 90 days when the reviewed audit baseline is enabled."
  type        = number
  default     = 30

  validation {
    condition = (
      (
        !var.enable_log_analytics_audit_baseline &&
        var.log_analytics_retention_in_days == 30
      ) ||
      (
        var.enable_log_analytics_audit_baseline &&
        var.log_analytics_retention_in_days == 90
      )
    )
    error_message = "Log Analytics retention must be 30 days while staged and 90 days when the reviewed audit baseline is enabled"
  }
}

variable "log_analytics_daily_quota_gb" {
  description = "Daily Log Analytics cap: 0.5 GiB while staged and -1 only after the reviewed audit baseline and cost alerts are enabled."
  type        = number
  default     = 0.5

  validation {
    condition = (
      (
        !var.enable_log_analytics_audit_baseline &&
        var.log_analytics_daily_quota_gb == 0.5
      ) ||
      (
        var.enable_log_analytics_audit_baseline &&
        var.log_analytics_daily_quota_gb == -1
      )
    )
    error_message = "Log Analytics daily quota must be 0.5 while staged and -1 when the reviewed audit baseline is enabled"
  }
}

variable "deploy_container_app" {
  description = "Deploy the API after its referenced image exists in ACR."
  type        = bool
  default     = false
}

variable "container_image_repository" {
  description = "Repository path inside ACR for the scribe API image."
  type        = string
  default     = "cosmaneura-scribe-api"
}

variable "container_image_tag" {
  description = "Immutable image tag, normally the Git commit SHA."
  type        = string
  default     = "not-deployed"
}

variable "enable_master_platform_handoff" {
  description = "Enable Entra-authenticated transcript delivery to the master platform."
  type        = bool
  default     = false
}

variable "master_platform_base_url" {
  description = "HTTPS origin of the master platform; contains no credential."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_master_platform_handoff ||
      can(regex("^https://", var.master_platform_base_url))
    )
    error_message = "master_platform_base_url must be HTTPS when handoff is enabled"
  }
}

variable "master_platform_scope" {
  description = "Entra API scope in api://<app-id>/.default form; contains no credential."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_master_platform_handoff ||
      can(regex("^api://.+/\\.default$", var.master_platform_scope))
    )
    error_message = "master_platform_scope must use api://<app-id>/.default when enabled"
  }
}

variable "enable_workflow_authentication" {
  description = "Require Entra app-only authentication on every /v1 workflow route."
  type        = bool
  default     = false
}

variable "enable_capture_protocol" {
  description = "Expose the offline-safe capture lease, reservation, authorization, and receipt contract. Remains false until PostgreSQL and the platform BFF are ready."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_capture_protocol ||
      (
        var.enable_workflow_authentication &&
        var.use_postgres_repository
      )
    )
    error_message = "enable_capture_protocol requires workflow authentication and the PostgreSQL repository"
  }
}

variable "workflow_api_audience" {
  description = "Scribe API application client ID accepted in v2 access-token aud claims."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_workflow_authentication ||
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.workflow_api_audience))
    )
    error_message = "workflow_api_audience must be the Scribe API client ID UUID when enabled"
  }
}

variable "trusted_platform_client_id" {
  description = "Client ID of the one platform workload identity allowed to call Scribe."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_workflow_authentication ||
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.trusted_platform_client_id))
    )
    error_message = "trusted_platform_client_id must be a UUID when authentication is enabled"
  }
}

variable "connect_parallel_platform_vnet" {
  description = "Create Scribe-owned reverse peering and private-DNS link after a separately approved platform foundation plan."
  type        = bool
  default     = false
}

variable "parallel_platform_vnet_id" {
  description = "Non-secret resource ID of the approved parallel platform VNet."
  type        = string
  default     = ""

  validation {
    condition = (
      var.parallel_platform_vnet_id == "" ||
      can(regex("^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.Network/virtualNetworks/[^/]+$", var.parallel_platform_vnet_id))
    )
    error_message = "parallel_platform_vnet_id must be an Azure virtual network resource ID"
  }
}

variable "deploy_postgres_foundation" {
  description = "Create the paid private PostgreSQL foundation after a separately approved plan."
  type        = bool
  default     = false
}

variable "deploy_database_migration_job" {
  description = "Create the manual passwordless database bootstrap/migration job."
  type        = bool
  default     = false

  validation {
    condition     = !var.deploy_database_migration_job || var.deploy_postgres_foundation
    error_message = "deploy_database_migration_job requires deploy_postgres_foundation=true"
  }
}

variable "use_postgres_repository" {
  description = "Switch the API from process memory to PostgreSQL after bootstrap succeeds."
  type        = bool
  default     = false

  validation {
    condition     = !var.use_postgres_repository || var.deploy_postgres_foundation
    error_message = "use_postgres_repository requires deploy_postgres_foundation=true"
  }
}

variable "deploy_transcription_job" {
  description = "Create the manual transcription job and its dedicated managed identity."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.deploy_transcription_job ||
      (
        var.deploy_postgres_foundation &&
        can(regex("^[0-9a-f]{40}$", var.container_image_tag))
      )
    )
    error_message = "deploy_transcription_job requires PostgreSQL and a lowercase 40-character commit SHA image tag"
  }
}

variable "enable_transcription_job" {
  description = "Enable one-target manual transcription executions and their data-plane roles."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_transcription_job ||
      (
        var.deploy_transcription_job &&
        var.deploy_database_migration_job &&
        var.use_postgres_repository &&
        var.deploy_private_speech_foundation
      )
    )
    error_message = "enable_transcription_job requires the deployed migration, transcription, private Speech foundation, and PostgreSQL API cutover"
  }
}

variable "deploy_private_speech_foundation" {
  description = "Create the dedicated private Speech account, DNS, endpoint, and safe diagnostics."
  type        = bool
  default     = false
}

variable "deploy_speech_smoke_job" {
  description = "Create the manual two-case synthetic Speech acceptance job and identity."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.deploy_speech_smoke_job ||
      (
        var.deploy_private_speech_foundation &&
        can(regex("^[0-9a-f]{40}$", var.container_image_tag))
      )
    )
    error_message = "deploy_speech_smoke_job requires the private Speech foundation and a lowercase 40-character commit SHA image tag"
  }
}

variable "enable_speech_smoke_job" {
  description = "Allow the pinned synthetic smoke job to call the private Speech account."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_speech_smoke_job || var.deploy_speech_smoke_job
    error_message = "enable_speech_smoke_job requires deploy_speech_smoke_job=true"
  }
}

variable "deploy_private_terraform_runner" {
  description = "Create the temporary, manual private plan/apply jobs and their dedicated managed identity."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.deploy_private_terraform_runner ||
      (
        var.environment == "development" &&
        var.create_resource_group &&
        can(regex("^[0-9a-f]{40}$", var.private_terraform_runner_image_tag)) &&
        can(regex("^sha256:[0-9a-f]{64}$", var.private_terraform_runner_image_digest))
      )
    )
    error_message = "the temporary Terraform runner is development-only, requires the existing Terraform-owned resource group, and requires a lowercase 40-character source commit plus sha256 image digest"
  }
}

variable "enable_private_terraform_runner" {
  description = "Temporarily grant the private runner its five narrow enabled roles and permit its fixed plan/apply entrypoints to authenticate."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_private_terraform_runner || var.deploy_private_terraform_runner
    error_message = "enable_private_terraform_runner requires deploy_private_terraform_runner=true"
  }

  validation {
    condition = (
      !var.enable_private_terraform_runner ||
      (
        var.deploy_container_app &&
        var.container_image_repository == "cosmaneura-scribe-api" &&
        var.container_image_tag == "804c4bacd692bc157ab101ff5055d999e00a37cc" &&
        var.enable_workflow_authentication &&
        !var.enable_capture_protocol &&
        var.workflow_api_audience == "57264fe1-6a4a-4946-8412-e0be18805977" &&
        var.trusted_platform_client_id == "c7bae168-fbf5-4658-b0d9-dd4b5373a1be" &&
        var.deploy_private_api_acceptance_job &&
        (
          var.private_terraform_reconciliation_completed ||
          (
            !var.enable_private_api_acceptance_job &&
            !var.allow_private_api_acceptance_invocation
          )
        ) &&
        !var.enable_master_platform_handoff &&
        !var.connect_parallel_platform_vnet &&
        var.deploy_private_speech_foundation &&
        var.deploy_speech_smoke_job &&
        !var.enable_speech_smoke_job &&
        !var.deploy_postgres_foundation &&
        !var.deploy_database_migration_job &&
        !var.use_postgres_repository &&
        !var.deploy_transcription_job &&
        !var.enable_transcription_job &&
        !var.deploy_delivery_reconciler_job &&
        !var.enable_delivery_reconciler_job &&
        !var.enable_development_cost_guardrails &&
        !var.enable_log_analytics_audit_baseline &&
        !var.enable_phi_safe_data_plane_diagnostics &&
        var.log_analytics_retention_in_days == 30 &&
        var.log_analytics_daily_quota_gb == 0.5
      )
    )
    error_message = "the temporary runner requires the immutable reviewed live manifest: API image 804c4ba with exact workflow audience/caller and handoff disabled; the API acceptance job deployed with both gates closed until private_terraform_reconciliation_completed=true; dormant Speech smoke deployed; Speech invocation, clinical transcription, delivery reconciliation, PostgreSQL, peering, budget, baseline, and diagnostics disabled; LAW held at 30 days/0.5 GiB"
  }
}

variable "private_terraform_runner_image_repository" {
  description = "Repository path in the Scribe ACR for the dedicated OpenTofu runner image."
  type        = string
  default     = "cosmaneura-scribe-terraform-runner"

  validation {
    condition     = can(regex("^[a-z0-9]+(?:[._/-][a-z0-9]+)*$", var.private_terraform_runner_image_repository))
    error_message = "private_terraform_runner_image_repository must be a lowercase ACR repository path"
  }
}

variable "private_terraform_runner_image_tag" {
  description = "Source commit SHA used to build the dedicated private runner image; the deployment itself is digest-pinned."
  type        = string
  default     = "not-deployed"
}

variable "private_terraform_runner_image_digest" {
  description = "Immutable sha256 digest of the dedicated private runner image."
  type        = string
  default     = "not-deployed"
}

variable "terraform_state_container_resource_id" {
  description = "Exact remote-state Blob container assignment scope; ABAC limits the temporary runner to the state, plan, and manifest object paths."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_private_terraform_runner ||
      (
        can(regex(
          "^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/[Mm]icrosoft\\.[Ss]torage/storageAccounts/[^/]+/blobServices/default/containers/[^/]+$",
          var.terraform_state_container_resource_id,
        )) &&
        lower(var.terraform_state_container_resource_id) == lower(
          "/subscriptions/${var.subscription_id}/resourceGroups/${var.terraform_state_resource_group_name}/providers/Microsoft.Storage/storageAccounts/${var.terraform_state_storage_account_name}/blobServices/default/containers/${var.terraform_state_container_name}"
        )
      )
    )
    error_message = "terraform_state_container_resource_id must exactly match the enabled runner backend subscription, resource group, account, and container"
  }
}

variable "terraform_state_resource_group_name" {
  description = "Remote-state resource group name passed to the runner's AzureRM backend."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_private_terraform_runner ||
      can(regex("^[A-Za-z0-9._()\\-]{1,90}$", var.terraform_state_resource_group_name))
    )
    error_message = "terraform_state_resource_group_name must be a valid Azure resource group name when the private runner is enabled"
  }
}

variable "terraform_state_storage_account_name" {
  description = "Remote-state storage account name passed to the runner's AzureRM backend."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_private_terraform_runner ||
      can(regex("^[a-z0-9]{3,24}$", var.terraform_state_storage_account_name))
    )
    error_message = "terraform_state_storage_account_name must be a valid storage account name when the private runner is enabled"
  }
}

variable "terraform_state_container_name" {
  description = "Remote-state container name used by the runner for both state and the reviewed saved plan."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_private_terraform_runner ||
      can(regex("^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$", var.terraform_state_container_name))
    )
    error_message = "terraform_state_container_name must be a valid Blob container name when the private runner is enabled"
  }
}

variable "terraform_state_key" {
  description = "Existing Scribe development state blob key; this workflow never migrates or replaces it."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_private_terraform_runner ||
      (
        can(regex("^[A-Za-z0-9][A-Za-z0-9._/-]*$", var.terraform_state_key)) &&
        !strcontains(var.terraform_state_key, "..")
      )
    )
    error_message = "terraform_state_key must name the existing state blob without traversal when the private runner is enabled"
  }
}

variable "private_terraform_plan_blob_name" {
  description = "Unique .tfplan object name bound to reviewer-pinned content and state metadata before apply."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.enable_private_terraform_runner ||
      (
        can(regex("^[a-z0-9][a-z0-9._/-]*\\.tfplan$", var.private_terraform_plan_blob_name)) &&
        !strcontains(var.private_terraform_plan_blob_name, "..") &&
        var.private_terraform_plan_blob_name != var.terraform_state_key &&
        "${var.private_terraform_plan_blob_name}.manifest.json" != var.terraform_state_key
      )
    )
    error_message = "private_terraform_plan_blob_name must be a unique lowercase .tfplan path without traversal and must not collide with the state object"
  }
}

variable "postgres_server_name" {
  description = "Globally unique PostgreSQL Flexible Server name."
  type        = string
  default     = "cosmaneura-scribe-dev-pg"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$", var.postgres_server_name))
    error_message = "postgres_server_name must be 3-63 lowercase letters, numbers, or hyphens"
  }
}

variable "postgres_database_name" {
  description = "Application database created on the PostgreSQL server."
  type        = string
  default     = "cosmaneura_scribe"

  validation {
    condition     = can(regex("^[a-zA-Z0-9_]{1,63}$", var.postgres_database_name))
    error_message = "postgres_database_name must contain only letters, numbers, or underscores"
  }
}

variable "postgres_sku_name" {
  description = "Development PostgreSQL compute SKU; review before production use."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  description = "Provisioned PostgreSQL storage in MiB."
  type        = number
  default     = 32768
}

variable "tags" {
  description = "Resource tags. Never include PHI in tags."
  type        = map(string)
  default = {
    application = "cosmaneura-scribe"
    managed_by  = "opentofu"
  }
}
