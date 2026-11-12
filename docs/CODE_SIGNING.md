# ImageStorage Windows code signing

Public releases must be signed with a trusted Windows code-signing certificate.
The signed build intentionally fails when no certificate is supplied and verifies
both generated executables after packaging.

In PowerShell:

```powershell
$env:WIN_CSC_LINK = "C:\secure\ImageStorage-code-signing.pfx"
$env:WIN_CSC_KEY_PASSWORD = "PFX password"
npm run desktop:build:signed
```

Keep the PFX and password outside this repository. `.pfx` and `.p12` files are
ignored by Git.

The WDK development certificate currently installed on the development PC is a
test certificate. It is not used for public releases because other Windows PCs
do not trust it and it does not remove SmartScreen publisher warnings.
