targetScope = 'resourceGroup'

@description('Short environment name such as dev, staging, or prod.')
param environmentName string

@description('Azure region for PHI data residency.')
param location string = resourceGroup().location

var suffix = uniqueString(resourceGroup().id, environmentName)

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-cosmaneura-scribe-${environmentName}'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.50.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: { addressPrefix: '10.50.1.0/24' }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.50.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: 'kv-csscribe-${suffix}'
  location: location
  properties: {
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    sku: { family: 'A', name: 'standard' }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: 'stcsscribe${suffix}'
  location: location
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: false }
    isVersioningEnabled: true
  }
}

output virtualNetworkId string = network.id
output keyVaultId string = vault.id
output audioStorageAccountId string = storage.id

