# Starter Zync plugin

Copy this directory into a new project and replace the sample publisher, id, and name in `manifest.mjs` before distributing it.

Until `@zync-sh/plugin-sdk` is published, install it from your local Zync checkout:

```sh
npm install --save-dev /path/to/zync/packages/plugin-sdk
```

Then run `npm run validate`. That builds `dist/` and checks the manifest, referenced files, permissions, and package limits. You can pass the target app version directly with `npx zync-plugin validate dist --zync-version 2.32.2`.

To test locally, enable Developer Mode in Zync and install the `dist/` folder. Its pane should answer **Ask the Worker**. The pane cannot access the Worker API directly; messages go through Zync's bounded pane channel.

To sign a release, keep your publisher key outside the project and pass the validated `dist/` folder to Zync's signing tool. Do not publish the SDK, source files, keys, or `node_modules` as part of the plugin package.
