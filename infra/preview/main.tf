resource "azurerm_resource_group" "preview" {
  name     = var.resource_group_name
  location = local.normalized_location
  tags     = local.tags
}

resource "azurerm_user_assigned_identity" "runtime" {
  name                = local.runtime_identity_name
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "github_deployment" {
  name                = local.deployment_identity_name
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github_environment" {
  name                      = "github-${var.github_environment}"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_deployment.id
  issuer                    = "https://token.actions.githubusercontent.com"
  audience                  = ["api://AzureADTokenExchange"]
  subject                   = "repo:${var.github_repository}:environment:${var.github_environment}"
}
