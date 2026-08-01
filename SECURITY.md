# Security Policy

`@rcrsr/rill-cli` runs machine-generated rill scripts, spawns `npm` on user-supplied specifiers, and writes `rill-config.json` and bundle output to the filesystem. Specifier handling, path resolution, and the npm subprocess surface are first-class concerns rather than a subcategory of bugs. This policy describes what counts as a vulnerability, how to report one, and what to expect afterwards.

## Supported versions

Only the latest published release is supported. Fixes land there, and there are no backports to earlier releases.

Reproduce on the current release before reporting. If you cannot upgrade, say so in the report and give the version you tested. A defect that is already fixed still tells us the fix needs a clearer changelog entry.

The current version is on the [npm package page](https://www.npmjs.com/package/@rcrsr/rill-cli) and in [CHANGELOG.md](CHANGELOG.md).

This policy covers `@rcrsr/rill-cli`, published from this repository. The language runtime, the extensions, the agent framework, and the config library are separate repositories with their own policies. A sandbox escape in the runtime itself belongs to [rcrsr/rill](https://github.com/rcrsr/rill/security/policy).

## Reporting a vulnerability

Report privately through GitHub, on the [Security tab](https://github.com/rcrsr/rill-cli/security/advisories/new) of this repository. That opens a private advisory visible only to you and the maintainers.

Do not open a public issue for a vulnerability in a published release.

Include:

- The version you tested, and whether you reproduced it on the current release
- A minimal reproduction: the smallest command, project layout, and `rill-config.json` that shows the behaviour
- What a user running the CLI loses as a result, stated concretely
- Any environment the reproduction depends on: PATH contents, npm version, cwd

**Do not post working exploit payloads against a live project.** Describe the class of issue and give a minimal reproduction against a scratch directory instead.

## What to expect

| Stage | Target |
|-------|--------|
| Acknowledgement | 5 days |
| Initial assessment | 14 days |
| Fix or mitigation plan for a confirmed report | 30 days |

rill is maintained by a small team, so these are targets rather than guarantees. If a report goes quiet past acknowledgement, a nudge on the advisory thread is welcome.

On a confirmed report, the maintainers publish a GitHub Security Advisory, release a patched version, and credit you by name or handle unless you ask otherwise.

## Threat model

The premise is that a user runs this CLI against a project directory, and that the scripts, specifiers, and config it reads may be machine-generated or otherwise untrusted. The user controls which project they point it at. The inputs control what the CLI does with them.

### In scope

- **Argument injection into the npm subprocess.** A specifier, mount name, or version range that escapes its argv position and becomes an npm flag. Every argument is passed as a separate argv element with no shell concatenation; a defect in that is in scope.
- **Path traversal.** A mount path, specifier, or bundle entry that writes outside the project directory or the `.rill/npm/` prefix, or reads a file the invocation never named.
- **Config tampering.** An edit to `rill-config.json` that writes a value the user did not ask for, or a rollback that leaves the file in a state neither the original nor the intended one.
- **Enforcement bypass.** Any mechanism that gates, filters, or validates being defeated by a different flag spelling, an unhandled input shape, or an unlisted default. Defaults that fail open are a defect in this class.
- **Bundle output escaping its target.** A bundle that writes outside the output directory, or that embeds a local filesystem path the publisher did not intend to ship.
- **Resource exhaustion.** Adversarial input that wedges the process or grows memory unboundedly, rather than halting with a diagnostic.
- **Supply chain.** Anything in the published package contents or the release pipeline that lets a third party alter what consumers install.

### Out of scope

- **A script doing what the project's mounted extensions authorize.** The capability model puts that choice with whoever wrote `rill-config.json`. That boundary belongs to [rcrsr/rill](https://github.com/rcrsr/rill/security/policy).
- **A user running the CLI against a project they do not trust.** Reading a hostile `rill-config.json` and installing what it names is the tool working; the trust decision is pointing it at that directory.
- **Anything requiring the attacker to already control the invocation, the PATH, or the npm registry the user configured.** That is already full control.
- **Vulnerabilities in npm itself, or in packages the CLI installs on the user's behalf.** Report those to their maintainers. A defect in how this CLI *invokes* npm is in scope.
- **Findings from a scanner with no demonstrated impact on a real invocation.**

If you are unsure which side a finding falls on, report it. A borderline report that turns out to be by-design costs less than an unreported bypass.

## Hardening guidance for users

- **Review `rill-config.json` before running against an unfamiliar project.** Its `extensions.mounts` entries name packages this CLI will install and the runtime will load.
- **Prefer a scoped `.rill/npm/` prefix over a global install.** It keeps installed extensions to the project that asked for them, and it is what `rill install` uses by default.
- **Treat script-chosen names as untrusted input.** Mount names and specifiers come from whoever wrote the config or the script, not from you.
