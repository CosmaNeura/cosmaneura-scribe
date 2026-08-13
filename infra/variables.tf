variable "subscription_id" {
  description = "Azure subscription containing the development environment."
  type        = string
  sensitive   = true
}

variable "tenant_id" {
  description = "Microsoft Entra tenant ID."
  type        = string
  sensitive   = true
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
