variable "subscription_id" {
  description = "Azure subscription that owns the isolated synthetic preview environment."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a UUID."
  }
}

variable "tenant_id" {
  description = "Microsoft Entra tenant used by the GitHub workload identity."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.tenant_id))
    error_message = "tenant_id must be a UUID."
  }
}

variable "location" {
  description = "Azure region for every preview resource. This stack is intentionally pinned to East US 2."
  type        = string
  default     = "eastus2"

  validation {
    condition     = lower(replace(var.location, " ", "")) == "eastus2"
    error_message = "The synthetic preview stack must remain in East US 2."
  }
}

variable "resource_group_name" {
  description = "Dedicated resource group for the synthetic capture preview."
  type        = string
  default     = "cosmaneura-capture-preview-development"

  validation {
    condition = (
      can(regex("^[A-Za-z0-9._()-]{1,90}$", var.resource_group_name)) &&
      can(regex("preview", lower(var.resource_group_name))) &&
      !can(regex("prod($|uction)", lower(var.resource_group_name)))
    )
    error_message = "resource_group_name must be a non-production preview resource-group name."
  }
}

variable "resource_suffix" {
  description = "Reviewed globally unique suffix used for this preview's public Azure names."
  type        = string
  default     = "p8x6m2"

  validation {
    condition     = var.resource_suffix == "p8x6m2"
    error_message = "resource_suffix is pinned to the reviewed and availability-checked value p8x6m2."
  }
}

variable "github_oidc_repository_subject" {
  description = "Exact immutable owner@owner_id/repository@repository_id prefix issued by GitHub OIDC."
  type        = string
  default     = "CosmaNeura@186940615/cosmaneura-scribe@1333303738"

  validation {
    condition     = var.github_oidc_repository_subject == "CosmaNeura@186940615/cosmaneura-scribe@1333303738"
    error_message = "This preview deployment identity is restricted to the immutable CosmaNeura/cosmaneura-scribe owner and repository IDs."
  }
}

variable "github_environment" {
  description = "Protected GitHub environment encoded in the OIDC subject."
  type        = string
  default     = "capture-preview"

  validation {
    condition     = var.github_environment == "capture-preview"
    error_message = "The federated subject must remain restricted to the capture-preview environment."
  }
}

variable "cosmos_database_name" {
  description = "Synthetic preview Cosmos SQL database name."
  type        = string
  default     = "capture-preview"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.cosmos_database_name))
    error_message = "cosmos_database_name must contain only letters, numbers, underscores, or hyphens."
  }
}

variable "cosmos_container_name" {
  description = "Synthetic preview state container name."
  type        = string
  default     = "workflow-state"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.cosmos_container_name))
    error_message = "cosmos_container_name must contain only letters, numbers, underscores, or hyphens."
  }
}

variable "cosmos_default_ttl_seconds" {
  description = "Fail-safe maximum lifetime for synthetic preview control state. Envelope records set a shorter one-hour item TTL."
  type        = number
  default     = 86400

  validation {
    condition     = var.cosmos_default_ttl_seconds == 86400
    error_message = "cosmos_default_ttl_seconds is pinned to the hosted preview's 24-hour control-state lifetime."
  }
}

variable "function_maximum_instance_count" {
  description = "Hard scale-out ceiling for the synthetic preview Function."
  type        = number
  default     = 3

  validation {
    condition     = var.function_maximum_instance_count >= 1 && var.function_maximum_instance_count <= 5
    error_message = "function_maximum_instance_count must remain between one and five."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly resource-group budget for the non-production preview."
  type        = number
  default     = 25

  validation {
    condition     = var.monthly_budget_usd >= 10 && var.monthly_budget_usd <= 100
    error_message = "monthly_budget_usd must remain between 10 and 100 USD."
  }
}

variable "budget_start_date" {
  description = "First UTC day of the month when the preview budget begins."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-01T00:00:00Z$", var.budget_start_date))
    error_message = "budget_start_date must be the first UTC day of a month in RFC3339 form."
  }
}

variable "budget_notification_action_group_ids" {
  description = "Optional reviewed Azure Monitor action groups for actual and forecast alerts. Empty creates a disabled no-contact notification."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for action_group_id in var.budget_notification_action_group_ids :
      can(regex(
        "^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/[Mm]icrosoft\\.[Ii]nsights/actionGroups/[^/]+$",
        action_group_id,
      ))
    ])
    error_message = "Every budget notification target must be a complete Azure Monitor action-group resource ID."
  }
}

variable "tags" {
  description = "Additional non-sensitive tags. Fixed safety-boundary tags cannot be overridden."
  type        = map(string)
  default     = {}
}
