# Contributing

You can contribute instance URLs, report incorrect results, or change the checker. Read the [Code of Conduct](CODE_OF_CONDUCT.md) before taking part. For vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Add or update an instance

Edit `data/instances.json` or use the [instance request form](https://github.com/shadersmods/libretranslate-remote-database/issues/new?template=01-instance-request.yml).

- Use a unique lowercase ID and the API base URL. Keep any deployment prefix or explicit port. Prefer HTTPS; HTTP-only entries require `allow_insecure_http: true` and use unencrypted requests.
- Include a public source that identifies the service. Describe any access restrictions you know about.
- Keep API keys, personal information, and private network addresses out of the catalog and reports.
- Check the operator's usage terms. A public translation page does not establish permission for general API use.

Set `probe_translation` to `false` to stop translation POST checks, or `enabled` to `false` to stop all checks. Operators can use the [operator request form](https://github.com/shadersmods/libretranslate-remote-database/issues/new?template=04-operator-request.yml) to request an opt-out or removal.

## Work on the checker

Use Node.js 24 or later. There are no packages to install.

```sh
npm run validate
npm test
```

The tests use local fixtures and make no external requests. Add tests when a change affects response parsing, access classification, URL handling, or generated output.

Run `npm run check` only when a live check is needed. It sends requests to every enabled server. Use harmless sample text and keep requests within the operator's limits. Pull request CI runs validation and tests without probing the proposed URLs.

## Send a pull request

Describe the problem, the change, and the checks you ran. For an instance change, include the source link and explain how it affects the listing or probes. Keep unrelated changes in separate pull requests.

Edit the catalog or checker source rather than the generated `STATUS.md`, `data/status.json`, `data/open.json`, or daily history files. The check workflow regenerates those files.

Contributions are covered by the repository's [MIT license](LICENSE). Keep notices for any third-party material you add.
