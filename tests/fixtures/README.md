# Build fixtures

Minimal but genuinely buildable apps, one per framework `detect.js` supports.
They serve two tiers of tests:

- `detect.fixtures.test.js` — runs `detectFramework()` against each fixture and
  snapshots the generated `captain-definition`. Fast, always runs.
- `build.test.js` — gated behind `RUN_DOCKER_BUILDS=1`. Generates the
  captain-definition exactly as CapRover would (`dockerfileLines` → `Dockerfile`),
  `docker build`s it, runs the container, and HTTP-probes the exposed port.

Each fixture's app responds on `/` with `hello from <framework>` so the build
tier can assert the image actually serves.

> The `node` fixture intentionally ships **without** a lockfile — the common case
> for a member who just pushes source. It exists to catch install-command bugs.
