# Security Policy

## Supported versions

SignalX is pre-1.0. Security fixes are applied to the latest published release
only — there are no backports to earlier lines, so upgrading is the fix. The
current release is on the
[releases page](https://github.com/signalxjs/core/releases) and on
[npm](https://www.npmjs.com/package/sigx); `sigx` and every framework package
under `packages/` publish together at that same version.

| Version        | Supported |
|----------------|-----------|
| Latest release | ✅        |
| Anything older | ❌        |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Use one of the following private channels:

1. **GitHub Security Advisories** — preferred. Open a private report at
   <https://github.com/signalxjs/core/security/advisories/new>.
2. **Email** — contact the maintainer directly. See the `author` field in
   [`package.json`](./package.json) and the GitHub profile linked from there.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally a minimal proof of concept.
- Affected package(s) and version(s).
- Any suggested mitigation, if you have one.

## Response

- We aim to acknowledge new reports within a few business days.
- Once a fix is ready, a patched version will be published to npm and a
  security advisory will be posted on GitHub crediting the reporter
  (unless they prefer to remain anonymous).
