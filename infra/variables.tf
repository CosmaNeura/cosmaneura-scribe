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

variable "tags" {
  description = "Resource tags. Never include PHI in tags."
  type        = map(string)
  default = {
    application = "cosmaneura-scribe"
    managed_by  = "opentofu"
  }
}
