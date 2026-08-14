# Master platform to Scribe authentication

The master platform is the sole source-of-truth caller for Scribe workflow routes. Staff continue
to sign in to the platform with the existing staff identity flow, patients keep the existing
patient identity service, and Scribe never receives either browser session. The platform exchanges
its Azure managed identity for a short-lived Entra access token.

All `/v1/*` routes fail closed when workload authentication is disabled or incomplete. `/healthz`
and `/readyz` remain available to Container Apps probes. The API accepts the practice-scoped
`X-Tenant-ID` header only after it verifies all of the following token properties:

- RS256 signature from the configured Entra tenant;
- exact v2 issuer, API audience, and `tid` directory tenant;
- app-only `idtyp=app` token;
- exact `azp` client ID of the platform managed identity; and
- the `Scribe.Workflow.Access` application role.

`X-Tenant-ID` is the Cosmaneura practice boundary. It is not the Entra directory tenant. This
header is not accepted from a browser, patient, scheduling vendor, or an arbitrary Azure workload.

## One-time Entra setup

Use Azure Portal → Microsoft Entra ID → App registrations. Identifiers below are non-secret.

1. Register or select the Scribe API application.
2. Under **Expose an API**, set its Application ID URI to `api://<scribe-api-application-id>`.
3. Configure the API to issue v2 access tokens and add the `idtyp` optional claim to **access
   tokens** on this Scribe API resource application. Scribe requires `idtyp=app` so a delegated
   user token cannot impersonate a trusted caller by client ID.
4. Under **App roles**, create an application role with value `Scribe.Workflow.Access`, allowed
   member type **Applications**, and a description limited to the Scribe workflow API.
5. Locate the enterprise application/service principal for the master platform's user-assigned
   managed identity.
6. Assign that service principal the Scribe API's `Scribe.Workflow.Access` application role using
   Microsoft Graph through Azure CLI or Microsoft Graph PowerShell. This is an application-role
   assignment, not an Azure subscription IAM role. Follow Microsoft's
   [managed-identity app-role guide](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/assign-app-role-managed-identity-powershell).
   Do not create a client secret.
7. Record the Entra tenant ID, Scribe API client ID audience, and platform managed-identity client ID in the
   gitignored development variable file. Never record tokens.

The platform requests `api://<scribe-api-application-id>/.default`; Scribe validates the resulting
v2 token's `aud` as the bare Scribe API application client ID UUID. The scope and audience are
intentionally not the same string.

## Safe rollout

1. Deploy the Scribe revision with `enable_workflow_authentication = false`. It remains unreachable
   for workflow calls while health probes continue to pass.
2. Attach the platform managed identity and deploy the platform client with its feature flag off.
3. Complete the Entra role assignment and administrator consent.
4. Set the Scribe audience and exact platform client ID, enable workflow authentication, and deploy.
5. From the platform runtime, call `/healthz`, then make one synthetic consent/session request.
   Expect a 2xx response. Verify a missing token returns 401, a wrong caller or role returns 403,
   and a disabled/incomplete configuration returns 503.
6. Enable the platform's Scribe client flag only after the synthetic tenant-isolation test passes.

Rollback is to disable the platform caller first. Do not temporarily allow unauthenticated `/v1`
traffic. Network isolation remains a second boundary, not a substitute for token verification.

## Private network path

Authentication does not create network reachability. The live platform environment has no VNet,
so the approved design creates a separate East US platform VNet and empty Container Apps
environment. The platform state owns that foundation and its side of peering. This repository owns
the reverse peering and a link from Scribe's existing private Container Apps DNS zone to the new
platform VNet:

```hcl
connect_parallel_platform_vnet = false
parallel_platform_vnet_id      = "/subscriptions/<subscription>/resourceGroups/cosmaneura-prod/providers/Microsoft.Network/virtualNetworks/cosmaneura-prod-parallel-vnet"
```

Keep the flag false until the platform VNet exists and both enabled plans receive separate
approval. This development Scribe environment is for synthetic connectivity validation only; it
must not receive production customer traffic. No deployment, feature enablement, or cutover is
authorized by the network design.
