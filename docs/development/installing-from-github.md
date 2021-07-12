# Installing from GitHub

If you need to test changes from GitHub, e.g. a branch that fixes an issue you have, here's what you need to do:

1. **This repo uses `yarn v2` workspaces**, so make sure you have `yarn` installed.  
   If not: `npm i -g yarn`
1. Clone and open this repo, check out the branch:
    ```bash
    git clone https://github.com/zwave-js/node-zwave-js.git
    cd node-zwave-js
    git checkout branch-you-want-to-test
    ```
1. Install dependencies, compile the sources
    ```bash
    yarn
    yarn run build
    ```
1. Link the `zwave-js` packages into your repo:
    1. If your repo is using `yarn v2`, execute this in your repo:
        ```bash
        yarn link /path/to/node-zwave-js --all
        ```
    1. If your repo is using `yarn v1`, add the following to your `package.json`, where `/path/to/zwave-js` needs to be the actual path of the `node-zwave-js` repo:
        ```json
        "resolutions": {
            "@zwave-js/config": "link:/path/to/zwave-js/packages/config",
            "@zwave-js/core": "link:/path/to/zwave-js/packages/core",
            "@zwave-js/maintenance": "link:/path/to/zwave-js/packages/maintenance",
            "@zwave-js/serial": "link:/path/to/zwave-js/packages/serial",
            "@zwave-js/shared": "link:/path/to/zwave-js/packages/shared",
            "@zwave-js/testing": "link:/path/to/zwave-js/packages/testing",
            "zwave-js": "link:/path/to/zwave-js/packages/zwave-js"
        }
        ```
        And execute `yarn` in your repo to set up the links.
    1. If your repo is using `npm` run this in the `node-zwave-js` repo:
        ```bash
        lerna exec -- npm link
        ```
        And this in your repo (for every package you use directly:)
        ```bash
        npm link zwave-js
        npm link @zwave-js/config
        # ... others
        ```
1. (Re)start your application
1. If you're planning to work on `zwave-js`, run `yarn run watch` to continuously rebuild the changes
1. Don't forget to remove the `"resolutions"` field and run `yarn` again when you're done testing.
