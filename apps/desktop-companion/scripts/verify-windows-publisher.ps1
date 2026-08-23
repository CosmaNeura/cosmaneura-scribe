param(
    [Parameter(Mandatory = $true)]
    [string] $ArtifactPath,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedPublisherSubject
)

$ErrorActionPreference = "Stop"
$signature = Get-AuthenticodeSignature -LiteralPath $ArtifactPath

if ($signature.Status -ne "Valid") {
    exit 1
}
if ($null -eq $signature.SignerCertificate) {
    exit 1
}
if ($signature.SignerCertificate.Subject -cne $ExpectedPublisherSubject) {
    exit 1
}
if ($null -eq $signature.TimeStamperCertificate) {
    exit 1
}

[Console]::Out.WriteLine("Authenticode publisher and timestamp verified.")
