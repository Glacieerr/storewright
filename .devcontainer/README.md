# Storewright in a codespace

This folder sets up a development container: Node 22 (as in `.nvmrc`, the `Dockerfile` and CI) with every
dependency from `package-lock.json` installed. Open it from the repository page with **Code → Codespaces → Create
codespace**, or in VS Code with **Dev Containers: Reopen in Container**. Nothing is installed on your own computer;
a codespace runs on your GitHub account's Codespaces allowance.

## Run the tests

```bash
npm test             # unit and property tests (Vitest)
npm run check        # type checks, then the same tests
```

Parts 2 and 3 have their own checks, as in CI:

```bash
npm test --workspace StoreX
npm test --workspace StoreX-Chain
```

## See it running

```bash
npm run build:site   # build the demo site
npm run demo:site    # serve it on port 4177; the forwarded port opens the showcase
```

Or the real backend with the associate app on port 8787:

```bash
npm run build:associate
npm run server
```

## End-to-end tests (optional)

They need a browser. Install Playwright's Chromium once per codespace, build everything, then run the default projects:

```bash
npx playwright install --with-deps chromium
npm run build:all
npm run e2e
```

`PW_CHANNEL` is set to empty in `devcontainer.json`, so Playwright uses its own Chromium instead of an installed Chrome,
the same as CI.
