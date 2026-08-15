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
  description = "Enable Blob and Key Vault audit diagnostics only after the workspace redaction transform is reviewed."
  type        = bool
  default     = false
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
