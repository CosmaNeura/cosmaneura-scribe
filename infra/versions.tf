terraform {
  required_version = ">= 1.8.0"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "= 2.13.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.14.0, < 5.0.0"
    }
  }

  backend "azurerm" {}
}

provider "azapi" {
  subscription_id            = var.subscription_id
  skip_provider_registration = true
  enable_preflight           = false
}

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  features {}
}
