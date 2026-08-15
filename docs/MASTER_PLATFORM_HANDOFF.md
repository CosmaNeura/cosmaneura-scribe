# Connect Scribe to the master platform

This connection uses Microsoft Entra workload identity. There is no client secret to create, copy,
or store. Staff continue to use Clerk, and patient authentication is unchanged.

## One-time Entra setup

1. Create or select an app registration representing the master-platform API.
2. Set its Application ID URI, normally `api://<platform-api-client-id>`.
3. Configure the platform API resource application to issue v2 access tokens and add the `idtyp`
   optional claim to **access tokens**. The API requires `idtyp=app`.
4. Add an **application role** with value `Scribe.Transcript.Write`, allowed member type
   **Applications**, and enable it.
5. Assign that role to the Scribe runtime managed identity's service principal through Microsoft
   Graph using Azure CLI or Microsoft Graph PowerShell. This is an application-role assignment to
   the platform API service principal, not an Azure subscription IAM role. Follow Microsoft's
   [managed-identity app-role guide](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/assign-app-role-managed-identity-powershell).

An Entra administrator can perform the role assignment in the portal under **Enterprise
applications**, or use Microsoft Graph. Record these non-secret identifiers:

- Entra tenant ID
- platform API audience: the application client ID UUID
- Scribe runtime managed-identity client ID
- Scribe runtime managed-identity principal/object ID
- platform API client ID and service-principal object ID
- `Scribe.Transcript.Write` app-role ID

Do not create an Entra client secret. Do not paste an access token into a terminal, `.env` file,
Terraform variable, GitHub setting, issue, or chat.

## Master-platform configuration

Configure these non-secret environment values on the master web Container App:

```text
SCRIBE_HANDOFF_ENABLED=true
ENTRA_TENANT_ID=<tenant-id>
SCRIBE_API_AUDIENCE=<platform-api-client-id>
SCRIBE_CALLER_CLIENT_ID=<scribe-managed-identity-client-id>
```

The endpoint validates signature, issuer, audience, tenant, expiry, `idtyp=app`, the exact caller
client ID, and the `Scribe.Transcript.Write` application role. A Clerk token cannot call it.

## Scribe configuration

Set these OpenTofu variables only after the master settings and Entra role assignment are active:

```hcl
enable_master_platform_handoff = true
master_platform_base_url       = "https://<master-platform-origin>"
master_platform_scope          = "api://<platform-api-client-id>/.default"
```

These become non-secret Container App settings. `DefaultAzureCredential` obtains a short-lived
token from the attached Scribe managed identity.

## Safe rollout

1. Keep both feature flags off while deploying the database migration and code revisions.
2. Enable the master endpoint first and verify a missing token returns `401` and a Scribe token
   without the app role returns `403`.
3. Use a synthetic canonical encounter and transcript. Enable Scribe delivery and submit once.
4. Submit the same Scribe session again and verify the same platform transcript ID returns with
   `replayed`; note generation must have been queued only once.
5. Verify the Scribe delivery ledger shows `delivered`, the session shows `handed_off`, and neither
   service logs transcript text, names, DOBs, tokens, URLs, or object names.
6. Expand the pilot by account. The current upload/AssemblyAI and legacy handoff paths remain
   available until acceptance metrics support retirement.

If delivery returns `retryable`, correct connectivity or availability and retry the same session;
Scribe automatically reuses its outbound idempotency key. A `terminal` result requires inspection
of the sanitized error code and an explicit operator decision before retrying.
