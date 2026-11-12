# macOS release signing

GitHub release builds for Apple Silicon must be signed with an Apple Developer ID Application certificate and notarised with an App Store Connect API key. The tag workflow fails before building the release app if any signing secret is missing; it does not publish an unsigned replacement.

## Configure repository secrets

Create these Actions secrets in the repository settings:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` file |
| `APPLE_SIGNING_IDENTITY` | Exact Developer ID Application identity shown by `security find-identity -v -p codesigning` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_PRIVATE_KEY` | Base64-encoded App Store Connect `.p8` private key |
| `KEYCHAIN_PASSWORD` | Strong, unique password for the temporary CI keychain |

Generate the `.p12` on a Mac from the Developer ID Application certificate and its private key. Encode both files without line breaks before saving the values as secrets:

```sh
base64 -i DeveloperID.p12 | tr -d '\n'
base64 -i AuthKey_ABC123.p8 | tr -d '\n'
```

The workflow imports the certificate into a temporary keychain, asks Tauri to sign and notarise the app, and removes the keychain and private key when the build ends. The signing and notarisation secrets are exposed only to tag-triggered macOS release steps, not pull request builds.

See the [Tauri macOS code signing guide](https://v2.tauri.app/distribute/sign/macos/) for creating the certificate and App Store Connect API key.
