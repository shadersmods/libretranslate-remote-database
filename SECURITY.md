# Security policy

## Report a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/shadersmods/libretranslate-remote-database/security/advisories/new). If private reporting is unavailable, email [neo@shadersmods.com](mailto:neo@shadersmods.com) with the subject `LibreTranslate remote database security report`.

Keep vulnerability details out of public issues and pull requests while a fix and disclosure are being discussed. Include the affected commit, steps to reproduce with harmless data, the expected and observed behavior, and the likely impact. Remove credentials, personal information, and private infrastructure details from logs or examples.

Test only on systems you own or have permission to test. Use a local fixture for network or parsing tests. Do not probe third-party services to demonstrate a vulnerability in this repository.

## What this repository covers

Reports can concern the checker in `lib/`, its command in `scripts/`, the catalog, generated output, or the GitHub Actions workflows. Examples include requests reaching private network addresses, credentials appearing in published output, unsafe handling of server responses, or a workflow exposing write access to untrusted contributions.

Include the exact commit you tested. Reproduce the issue on the current default branch when you can; state when that was not possible. This policy does not promise fixes for older commits or a response deadline.

## Service and listing problems

For an incorrect status, missing instance, or operator opt-out, use the issue forms. Report vulnerabilities in a listed LibreTranslate server to that server's operator. A server appearing in this catalog does not mean its security has been assessed.
