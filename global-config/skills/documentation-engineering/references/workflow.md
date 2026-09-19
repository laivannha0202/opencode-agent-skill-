# Documentation engineering workflow

Treat the repository and executable behavior as the source of truth.

Before writing:
- verify commands, paths, package names, environment variables and supported versions
- distinguish required setup from optional examples
- identify whether the audience is user, operator, contributor or API consumer
- check the nearest existing documentation style and navigation

Examples should be copyable and minimal. Mark placeholders clearly. Do not present future/planned behavior as implemented.

When documenting APIs or configuration, include defaults, failure behavior and compatibility constraints that materially affect use. When behavior changed, search for stale references across README, docs, examples and release notes.

Verification should run important commands when practical, validate links/paths, and compare documented outputs against current behavior. Prefer one accurate path over several speculative alternatives.
