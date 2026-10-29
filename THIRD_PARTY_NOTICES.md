# Third-party notices · 第三方组件声明

Storewright uses the open-source packages below at run time: in the associate app and simulator (and so in the in-browser demo site), and in the server. Each keeps its own license. This file lists them and reproduces the license texts and copyright notices that those licenses ask to be kept when the software is distributed, for example as the demo site or a Docker image. Development tools that are not distributed (TypeScript, Vite, Vitest, Playwright and the like) are not listed. A package listed here is installed as a run-time dependency; a bundler may leave unused parts out of the built files.

Storewright 在运行时用到下面这些开源软件包：员工作业端和模拟器（因此也包括浏览器内演示站点）以及服务端。它们各自保留自己的许可证。本文件列出这些软件包，并附上这些许可证要求在分发软件时保留的许可文本和版权声明（例如分发演示站点或 Docker 镜像时）。不随软件分发的开发工具（TypeScript、Vite、Vitest、Playwright 等）不列入。这里列出的是作为运行时依赖安装的软件包；打包工具可能会把没用到的部分排除在构建产物之外。

Generated from the installed packages by `npm run notices` (`scripts/third-party-notices.mjs`); run it again after changing dependencies. · 由 `npm run notices`（`scripts/third-party-notices.mjs`）根据已安装的软件包生成；改了依赖以后请重新生成。

## Summary · 汇总

| License · 许可证 | Packages · 软件包数 |
|---|---|
| MIT | 167 |
| ISC | 12 |
| BlueOak-1.0.0 | 8 |
| Apache-2.0 | 6 |
| BSD-3-Clause | 5 |
| 0BSD | 1 |
| **Total · 合计** | **199** |

All of these are permissive licenses that are compatible with distributing Storewright under AGPL-3.0. · 以上都是宽松许可证，与以 AGPL-3.0 发布 Storewright 兼容。

## Direct dependencies · 直接依赖

| Package · 软件包 | Version · 版本 | License · 许可证 | Used by · 使用方 |
|---|---|---|---|
| @electric-sql/pglite | 0.2.15 | Apache-2.0 | `apps/server` |
| @fastify/cors | 10.0.1 | MIT | `apps/server` |
| @fastify/static | 8.0.3 | MIT | `apps/server` |
| @fastify/websocket | 11.0.1 | MIT | `apps/server` |
| @react-three/drei | 9.117.3 | MIT | `apps/simulator` |
| @react-three/fiber | 8.17.10 | MIT | `apps/simulator` |
| fastify | 5.2.0 | MIT | `apps/server` |
| jsqr | 1.4.0 | Apache-2.0 | `apps/associate` |
| mqtt | 5.10.3 | MIT | `apps/server` |
| pg | 8.13.1 | MIT | `apps/server` |
| qrcode-generator | 1.4.4 | MIT | `packages/labels` |
| react | 18.3.1 | MIT | `apps/associate`, `apps/simulator` |
| react-dom | 18.3.1 | MIT | `apps/associate`, `apps/simulator` |
| three | 0.170.0 | MIT | `apps/simulator` |
| zod | 3.23.8 | MIT | `packages/store-config` |
| zustand | 4.5.7 | MIT | `apps/simulator` |

## Packages and license texts · 软件包与许可文本

### MIT (167)

| Package · 软件包 | Copyright · 版权声明 | Source · 来源 |
|---|---|---|
| @babel/runtime@7.29.10 | Copyright (c) 2014-present Sebastian McKenzie and other contributors | https://babel.dev/docs/en/next/babel-runtime |
| @fastify/accept-negotiator@2.1.1 | Copyright (c) 2022-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/accept-negotiator#readme |
| @fastify/ajv-compiler@4.0.7 | Copyright (c) 2022-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/ajv-compiler#readme |
| @fastify/cors@10.0.1 | Copyright (c) 2018 Fastify | https://github.com/fastify/fastify-cors#readme |
| @fastify/deepmerge@3.2.2 | Copyright (c) 2022-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/deepmerge#readme |
| @fastify/error@4.2.1 | Copyright (c) 2020-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/fastify-error#readme |
| @fastify/fast-json-stringify-compiler@5.1.1 | Copyright (c) 2022-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/fast-json-stringify-compiler#readme |
| @fastify/merge-json-schemas@0.2.2 | Copyright (c) 2024-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/merge-json-schemas#readme |
| @fastify/send@3.3.1 | Copyright (c) 2012 TJ Holowaychuk; Copyright (c) 2014-2022 Douglas Christopher Wilson; Copyright (c) 2023 The Fastify Team | https://github.com/fastify/send#readme |
| @fastify/static@8.0.3 | Copyright (c) 2017-2023 Fastify | https://github.com/fastify/fastify-static |
| @fastify/websocket@11.0.1 | Copyright (c) 2017 Fastify | https://github.com/fastify/fastify-websocket#readme |
| @lukeed/ms@2.0.2 | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) | https://github.com/lukeed/ms |
| @monogrid/gainmap-js@3.7.1 | Copyright (c) 2023 MONOGRID | https://github.com/MONOGRID/gainmap-js#readme |
| @pinojs/redact@0.4.0 | Copyright (c) 2025 pinojs contributors | https://github.com/pinojs/redact#readme |
| @react-spring/animated@9.7.5 | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors | https://github.com/pmndrs/react-spring#readme |
| @react-spring/core@9.7.5 | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors | https://github.com/pmndrs/react-spring#readme |
| @react-spring/shared@9.7.5 | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors | https://github.com/pmndrs/react-spring#readme |
| @react-spring/three@9.7.5 | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors | https://github.com/pmndrs/react-spring#readme |
| @react-spring/types@9.7.5 | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors | https://github.com/pmndrs/react-spring#readme |
| @react-three/drei@9.117.3 | Copyright (c) 2020 react-spring | https://github.com/pmndrs/drei |
| @react-three/fiber@8.17.10 | Copyright (c) Paul Henschel (https://github.com/drcmda) | https://github.com/pmndrs/react-three-fiber#readme |
| @tweenjs/tween.js@23.1.3 | Copyright (c) 2010-2012 Tween.js authors.; Easing equations Copyright (c) 2001 Robert Penner http://robertpenner.com/easing/ | https://github.com/tweenjs/tween.js |
| @types/draco3d@1.4.10 | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/draco3d |
| @types/node@22.10.2 | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node |
| @types/offscreencanvas@2019.7.3 | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/offscreencanvas |
| @types/react@18.3.12 | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react |
| @types/readable-stream@4.0.25 | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/readable-stream |
| @types/stats.js@0.17.4 | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/stats.js |
| @types/three@0.170.0 | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/three |
| @types/webxr@0.5.24 | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/webxr |
| @types/ws@8.5.13 | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/ws |
| @use-gesture/core@10.3.1 | Copyright (c) 2018-present Paul Henschel <drcmda@gmail.com> | https://use-gesture.netlify.app |
| @use-gesture/react@10.3.1 | Copyright (c) 2018-present Paul Henschel <drcmda@gmail.com> | https://use-gesture.netlify.app |
| abort-controller@3.0.0 | Copyright (c) 2017 Toru Nagashima | https://github.com/mysticatea/abort-controller#readme |
| abstract-logging@2.0.1 | Copyright (c) James Sumners <james.sumners@gmail.com> | https://github.com/jsumners/abstract-logging#readme |
| ajv@8.20.0 | Copyright (c) 2015-2021 Evgeny Poberezkin | https://ajv.js.org |
| ajv-formats@3.0.1 | Copyright (c) 2020 Evgeny Poberezkin | https://github.com/ajv-validator/ajv-formats#readme |
| atomic-sleep@1.0.0 | Copyright (c) 2020 David Mark Clements | https://github.com/davidmarkclements/atomic-sleep#readme |
| avvio@9.3.1 | Copyright (c) 2016-2020 Matteo Collina; Copyright (c) 2020-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/avvio#readme |
| balanced-match@4.0.4 | Original code Copyright Julian Gruber <julian@juliangruber.com>; Port to TypeScript Copyright Isaac Z. Schlueter <i@izs.me> | https://github.com/juliangruber/balanced-match |
| bidi-js@1.1.0 | Copyright (c) 2021 Jason Johnston | https://github.com/lojjic/bidi-js |
| bl@6.1.6 | Copyright (c) 2013-2019 bl contributors | https://github.com/rvagg/bl |
| brace-expansion@5.0.12 | Copyright Julian Gruber <julian@juliangruber.com>; TypeScript port Copyright Isaac Z. Schlueter <i@izs.me> | https://github.com/juliangruber/brace-expansion |
| buffer@6.0.3 | Copyright (c) Feross Aboukhadijeh, and other contributors. | https://github.com/feross/buffer |
| buffer-from@1.1.2 | Copyright (c) 2016, 2018 Linus Unnebäck | https://github.com/LinusU/buffer-from |
| camera-controls@2.10.1 | Copyright (c) 2017 @yomotsu | https://github.com/yomotsu/camera-controls |
| commist@3.2.0 | Copyright (c) 2014-2022 Matteo Collina | https://github.com/mcollina/commist |
| concat-stream@2.0.0 | Copyright (c) 2013 Max Ogden | http://github.com/maxogden/concat-stream |
| content-disposition@0.5.4 | Copyright (c) 2014-2017 Douglas Christopher Wilson | https://github.com/jshttp/content-disposition |
| cookie@2.0.1 | Copyright (c) 2012-2014 Roman Shtylman <shtylman@gmail.com>; Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> | https://github.com/jshttp/cookie |
| cross-env@7.0.3 | Copyright (c) 2017 Kent C. Dodds | https://github.com/kentcdodds/cross-env#readme |
| cross-spawn@7.0.6 | Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio> | https://github.com/moxystudio/node-cross-spawn |
| debug@4.4.3 | Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2018-2021 Josh Junon | https://github.com/debug-js/debug |
| depd@2.0.0 | Copyright (c) 2014-2018 Douglas Christopher Wilson | https://github.com/dougwilson/nodejs-depd |
| detect-gpu@5.0.70 | Copyright (c) 2020 Tim van Scherpenzeel | https://github.com/pmndrs/detect-gpu#readme |
| duplexify@4.1.3 | Copyright (c) 2014 Mathias Buus | https://github.com/mafintosh/duplexify |
| end-of-stream@1.4.5 | Copyright (c) 2014 Mathias Buus | https://github.com/mafintosh/end-of-stream |
| escape-html@1.0.3 | Copyright (c) 2012-2013 TJ Holowaychuk; Copyright (c) 2015 Andreas Lubbe; Copyright (c) 2015 Tiancheng "Timothy" Gu | https://github.com/component/escape-html |
| events@3.3.0 | Copyright Joyent, Inc. and other Node contributors. | https://github.com/Gozala/events |
| fast-decode-uri-component@1.0.1 | Copyright (c) 2018 Tomas Della Vedova; Copyright (c) 2017 Justin Ridgewell; Copyright (c) 2008-2009 Bjoern Hoehrmann <bjoern@hoehrmann.de> | https://github.com/delvedor/fast-decode-uri-component#readme |
| fast-deep-equal@3.1.3 | Copyright (c) 2017 Evgeny Poberezkin | https://github.com/epoberezkin/fast-deep-equal#readme |
| fast-json-stringify@6.4.0 | Copyright (c) 2016-present Matteo Collina; Copyright (c) 2016-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/fast-json-stringify#readme |
| fast-json-stringify@7.1.2 | Copyright (c) 2016-present Matteo Collina; Copyright (c) 2016-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/fast-json-stringify#readme |
| fast-querystring@1.1.2 | Copyright (c) 2022 Yagiz Nizipli | https://github.com/anonrig/fast-querystring |
| fast-unique-numbers@8.0.13 | Copyright (c) 2023 Christoph Guttandin | https://github.com/chrisguttandin/fast-unique-numbers |
| fastify@5.2.0 | Copyright (c) 2016-2024 The Fastify Team | https://fastify.dev/ |
| fastify-plugin@5.1.0 | Copyright (c) 2017-present The Fastify team | https://github.com/fastify/fastify-plugin#readme |
| fflate@0.6.11 | Copyright (c) 2020 Arjun Barrett | https://101arrowz.github.io/fflate |
| fflate@0.8.3 | Copyright (c) 2026 Arjun Barrett | https://101arrowz.github.io/fflate |
| find-my-way@9.10.0 | Copyright (c) 2017-2019 Tomas Della Vedova | https://github.com/delvedor/find-my-way#readme |
| forwarded@0.2.0 | Copyright (c) 2014-2017 Douglas Christopher Wilson | https://github.com/jshttp/forwarded |
| glsl-noise@0.0.0 | Copyright (C) 2011 by Ashima Arts (Simplex noise); Copyright (C) 2011 by Stefan Gustavson (Classic noise) | https://github.com/hughsk/glsl-noise |
| help-me@5.0.0 | Copyright (c) 2014-2022 Matteo Collina | https://github.com/mcollina/help-me |
| http-errors@2.0.1 | Copyright (c) 2014 Jonathan Ong me@jongleberry.com; Copyright (c) 2016 Douglas Christopher Wilson doug@somethingdoug.com | https://github.com/jshttp/http-errors |
| immediate@3.0.6 | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier | https://github.com/calvinmetcalf/immediate |
| ipaddr.js@1.9.1 | Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org> | https://github.com/whitequark/ipaddr.js |
| is-promise@2.2.2 | Copyright (c) 2014 Forbes Lindesay | https://github.com/then/is-promise |
| js-sdsl@4.3.0 | Copyright (c) 2021 Zilong Yao | https://js-sdsl.org |
| js-tokens@4.0.0 | Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell | https://github.com/lydell/js-tokens |
| json-schema-ref-resolver@3.0.1 | Copyright (c) 2023-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/json-schema-ref-resolver#readme |
| lie@3.3.0 | Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband | https://github.com/calvinmetcalf/lie |
| loose-envify@1.4.0 | Copyright (c) 2015 Andres Suarez <zertosh@gmail.com> | https://github.com/zertosh/loose-envify |
| maath@0.10.8 | (no license file in the package; package.json declares MIT) | — |
| meshline@3.3.1 | Copyright (c) 2016 Jaume Sanchez | https://github.com/pmndrs/meshline#readme |
| meshoptimizer@0.18.1 | Copyright (c) 2016-2022 Arseny Kapoulkine | https://github.com/zeux/meshoptimizer |
| mime@3.0.0 | Copyright (c) 2010 Benjamin Thomas, Robert Kieffer | https://github.com/broofa/mime |
| minimist@1.2.8 | Copyright (c) James Halliday | https://github.com/minimistjs/minimist |
| mnemonist@0.39.8 | Copyright (c) 2016 Guillaume Plique (Yomguithereal) | https://github.com/yomguithereal/mnemonist#readme |
| mqtt@5.10.3 | Copyright (c) 2015-2016 MQTT.js contributors; Copyright 2011-2014 by Adam Rudd | https://github.com/mqttjs/MQTT.js |
| mqtt-packet@9.0.2 | Copyright (c) 2014-2017 mqtt-packet contributors | https://github.com/mqttjs/mqtt-packet |
| ms@2.1.3 | Copyright (c) 2020 Vercel, Inc. | https://github.com/vercel/ms |
| number-allocator@1.0.14 | Copyright (c) 2021 Takatoshi Kondo | https://github.com/redboltz/number-allocator#readme |
| object-assign@4.1.1 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) | https://github.com/sindresorhus/object-assign |
| obliterator@2.0.5 | Copyright (c) 2017-2021 Guillaume Plique (Yomguithereal) | https://github.com/yomguithereal/obliterator#readme |
| on-exit-leak-free@2.1.2 | Copyright (c) 2021 Matteo Collina | https://github.com/mcollina/on-exit-or-gc#readme |
| pg@8.13.1 | Copyright (c) 2010 - 2021 Brian Carlson | https://github.com/brianc/node-postgres |
| pg-cloudflare@1.4.1 | Copyright (c) 2010 - 2021 Brian Carlson | https://github.com/brianc/node-postgres |
| pg-connection-string@2.14.1 | Copyright (c) 2014 Iced Development | https://github.com/brianc/node-postgres/tree/master/packages/pg-connection-string |
| pg-pool@3.14.0 | Copyright (c) 2017 Brian M. Carlson | https://github.com/brianc/node-postgres/tree/master/packages/pg-pool#readme |
| pg-protocol@1.16.1 | Copyright (c) 2010 - 2021 Brian Carlson | https://github.com/brianc/node-postgres |
| pg-types@2.2.0 | Copyright (c) Brian M. Carlson | https://github.com/brianc/node-pg-types |
| pgpass@1.0.6 | Copyright (c) Hannes Hörl <hannes.hoerl+pgpass@snowreporter.com> | https://github.com/hoegaarden/pgpass |
| pino@9.14.0 | Copyright (c) 2016-2025 Matteo Collina, David Mark Clements and the Pino contributors listed at <https://github.com/pinojs/pino#the-team> and in the README file. | https://getpino.io |
| pino-abstract-transport@2.0.0 | Copyright (c) 2021 pino | https://github.com/pinojs/pino-abstract-transport#readme |
| pino-std-serializers@7.1.0 | Copyright Mateo Collina, David Mark Clements, James Sumners | https://github.com/pinojs/pino-std-serializers#readme |
| postgres-array@2.0.0 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) | https://github.com/bendrucker/postgres-array |
| postgres-bytea@1.0.1 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) | https://github.com/bendrucker/postgres-bytea |
| postgres-date@1.0.7 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) | https://github.com/bendrucker/postgres-date |
| postgres-interval@1.2.0 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) | https://github.com/bendrucker/postgres-interval |
| process@0.11.10 | Copyright (c) 2013 Roman Shtylman <shtylman@gmail.com> | https://github.com/shtylman/node-process |
| process-nextick-args@2.0.1 | Copyright (c) 2015 Calvin Metcalf | https://github.com/calvinmetcalf/process-nextick-args |
| process-warning@4.0.1 | Copyright (c) Fastify | https://github.com/fastify/fastify-warning#readme |
| process-warning@5.1.1 | Copyright (c) 2020-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/fastify-warning#readme |
| prop-types@15.8.1 | Copyright (c) 2013-present, Facebook, Inc. | https://facebook.github.io/react/ |
| proxy-addr@2.0.8 | Copyright (c) 2014-2016 Douglas Christopher Wilson | https://github.com/jshttp/proxy-addr |
| qrcode-generator@1.4.4 | Copyright (c) Kazuhiko Arase | https://github.com/kazuhikoarase/qrcode-generator |
| quick-format-unescaped@4.0.4 | Copyright (c) 2016-2019 David Mark Clements | https://github.com/davidmarkclements/quick-format#readme |
| react@18.3.1 | Copyright (c) Facebook, Inc. and its affiliates. | https://reactjs.org/ |
| react-composer@5.0.3 | Copyright (c) 2018 James, please | https://github.com/jamesplease/react-composer |
| react-dom@18.3.1 | Copyright (c) Facebook, Inc. and its affiliates. | https://reactjs.org/ |
| react-is@16.13.1 | Copyright (c) Facebook, Inc. and its affiliates. | https://reactjs.org/ |
| readable-stream@3.6.2 | Copyright Node.js contributors. All rights reserved.; Copyright Joyent, Inc. and other Node contributors. All rights reserved. | https://github.com/nodejs/readable-stream |
| readable-stream@4.8.0 | Copyright Node.js contributors. All rights reserved.; Copyright Joyent, Inc. and other Node contributors. All rights reserved. | https://github.com/nodejs/readable-stream |
| real-require@0.2.0 | Copyright (c) 2021 Paolo Insogna and the real-require contributors | https://github.com/pinojs/real-require |
| reinterval@1.1.0 | Copyright (c) 2015 Agor Maxime | https://github.com/4rzael/reInterval |
| require-from-string@2.0.2 | Copyright (c) Vsevolod Strukchinsky <floatdrop@gmail.com> (github.com/floatdrop) | https://github.com/floatdrop/require-from-string |
| ret@0.5.1 | Copyright (C) 2011 by fent | https://github.com/fent/ret.js |
| reusify@1.1.0 | Copyright (c) 2015-2024 Matteo Collina | https://github.com/mcollina/reusify#readme |
| rfdc@1.4.1 | Copyright 2019 "David Mark Clements <david.mark.clements@gmail.com>" | https://github.com/davidmarkclements/rfdc#readme |
| safe-buffer@5.2.1 | Copyright (c) Feross Aboukhadijeh | https://github.com/feross/safe-buffer |
| safe-regex2@5.1.2 | Copyright (c) 2019-present The Fastify team <https://github.com/fastify/fastify#team> | https://github.com/fastify/safe-regex2 |
| safe-stable-stringify@2.5.0 | Copyright (c) Ruben Bridgewater | https://github.com/BridgeAR/safe-stable-stringify#readme |
| scheduler@0.23.2 | Copyright (c) Facebook, Inc. and its affiliates. | https://reactjs.org/ |
| set-cookie-parser@3.1.4 | Copyright (c) 2015 Nathan Friedly <nathan@nfriedly.com> (http://nfriedly.com/) | https://github.com/nfriedly/set-cookie-parser |
| sonic-boom@4.2.1 | Copyright (c) 2017 Matteo Collina | https://github.com/pinojs/sonic-boom#readme |
| stats-gl@2.4.2 | Copyright (c) Renaud ROHLINGER (https://github.com/RenaudRohlinger) | https://github.com/RenaudRohlinger/stats-gl |
| stats.js@0.17.0 | Copyright (c) 2009-2016 stats.js authors | https://github.com/mrdoob/stats.js |
| statuses@2.0.2 | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com> | https://github.com/jshttp/statuses |
| stream-shift@1.0.3 | Copyright (c) 2016 Mathias Buus | https://github.com/mafintosh/stream-shift |
| string_decoder@1.3.0 | Copyright Node.js contributors. All rights reserved.; Copyright Joyent, Inc. and other Node contributors. All rights reserved. | https://github.com/nodejs/string_decoder |
| suspend-react@0.1.3 | Copyright (c) 2021 Paul Henschel | https://github.com/pmndrs/suspend-react#readme |
| thread-stream@3.2.0 | Copyright (c) 2021 Matteo Collina | https://github.com/mcollina/thread-stream#readme |
| three@0.170.0 | Copyright © 2010-2024 three.js authors | https://threejs.org/ |
| three-mesh-bvh@0.7.8 | Copyright (c) 2018 Garrett Johnson | https://github.com/gkjohnson/three-mesh-bvh#readme |
| three-stdlib@2.36.1 | Copyright (c) 2021-2023 Poimandres | https://github.com/pmndrs/three-stdlib |
| toad-cache@3.7.4 | Copyright (c) 2023 Igor Savin | https://github.com/kibertoad/toad-cache |
| toidentifier@1.0.1 | Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com> | https://github.com/component/toidentifier |
| troika-three-text@0.52.5 | Copyright (c) 2019 ProtectWise; Copyright (c) 2021 Jason Johnston | https://github.com/protectwise/troika |
| troika-three-utils@0.52.5 | Copyright (c) 2019 ProtectWise; Copyright (c) 2021 Jason Johnston | https://github.com/protectwise/troika |
| troika-worker-utils@0.52.0 | Copyright (c) 2019 ProtectWise; Copyright (c) 2021 Jason Johnston | https://github.com/protectwise/troika |
| tunnel-rat@0.1.2 | Copyright (c) 2022 Poimandres | https://github.com/pmndrs/tunnel-rat#readme |
| typedarray@0.0.6 | Copyright (c) 2010, Linden Research, Inc.; Copyright (c) 2012, Joshua Bell | https://github.com/substack/typedarray |
| undici-types@6.20.0 | Copyright (c) Matteo Collina and Undici contributors | https://undici.nodejs.org |
| use-sync-external-store@1.7.0 | Copyright (c) Meta Platforms, Inc. and affiliates. | https://github.com/react/react |
| util-deprecate@1.0.2 | Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net>; NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT | https://github.com/TooTallNate/util-deprecate |
| utility-types@3.11.0 | Copyright (c) 2016 Piotr Witek <piotrek.witek@gmail.com> (http://piotrwitek.github.io) | https://github.com/piotrwitek/utility-types |
| uuid@9.0.1 | Copyright (c) 2010-2020 Robert Kieffer and other contributors | https://github.com/uuidjs/uuid |
| webgl-constants@1.1.1 | Copyright (c) 2019 Tim van Scherpenzeel | — |
| webgl-sdf-generator@1.1.1 | Copyright (c) 2021 Jason Johnston | https://github.com/lojjic/webgl-sdf-generator |
| worker-timers@7.1.8 | Copyright (c) 2024 Christoph Guttandin | https://github.com/chrisguttandin/worker-timers |
| worker-timers-broker@6.1.8 | Copyright (c) 2024 Christoph Guttandin | https://github.com/chrisguttandin/worker-timers-broker |
| worker-timers-worker@7.0.71 | Copyright (c) 2024 Christoph Guttandin | https://github.com/chrisguttandin/worker-timers-worker |
| ws@8.22.0 | Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors | https://github.com/websockets/ws |
| xtend@4.0.2 | Copyright (c) 2012-2014 Raynos. | https://github.com/Raynos/xtend |
| zod@3.23.8 | Copyright (c) 2020 Colin McDonnell | https://zod.dev |
| zustand@4.5.7 | Copyright (c) 2019 Paul Henschel | https://github.com/pmndrs/zustand |
| zustand@5.0.2 | Copyright (c) 2019 Paul Henschel | https://github.com/pmndrs/zustand |

License text shared by the packages above (each with its own copyright notice listed in the table): · 上表各软件包共用的许可文本（各自的版权声明见上表）：

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC (12)

| Package · 软件包 | Copyright · 版权声明 | Source · 来源 |
|---|---|---|
| fastq@1.20.3 | Copyright (c) 2015-2020, Matteo Collina <matteo.collina@gmail.com> | https://github.com/mcollina/fastq#readme |
| foreground-child@3.3.1 | Copyright (c) 2015-2023 Isaac Z. Schlueter and Contributors | https://github.com/tapjs/foreground-child |
| inherits@2.0.4 | Copyright (c) Isaac Z. Schlueter | https://github.com/isaacs/inherits |
| lru-cache@10.4.3 | Copyright (c) 2010-2023 Isaac Z. Schlueter and Contributors | https://github.com/isaacs/node-lru-cache |
| once@1.4.0 | Copyright (c) Isaac Z. Schlueter and Contributors | https://github.com/isaacs/once |
| pg-int8@1.0.1 | Copyright © 2017, Charmander <~@charmander.me> | https://github.com/charmander/pg-int8 |
| potpack@1.0.2 | Copyright (c) 2018, Mapbox | https://mapbox.github.io/potpack/ |
| semver@7.8.5 | Copyright (c) Isaac Z. Schlueter and Contributors | https://github.com/npm/node-semver |
| setprototypeof@1.2.0 | Copyright (c) 2015, Wes Todd | https://github.com/wesleytodd/setprototypeof |
| signal-exit@4.1.0 | Copyright (c) 2015-2023 Benjamin Coe, Isaac Z. Schlueter, and Contributors | https://github.com/tapjs/signal-exit |
| split2@4.2.0 | Copyright (c) 2014-2018, Matteo Collina <hello@matteocollina.com> | https://github.com/mcollina/split2 |
| wrappy@1.0.2 | Copyright (c) Isaac Z. Schlueter and Contributors | https://github.com/npm/wrappy |

License text shared by the packages above (each with its own copyright notice listed in the table): · 上表各软件包共用的许可文本（各自的版权声明见上表）：

```text
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### BlueOak-1.0.0 (8)

| Package · 软件包 | Copyright · 版权声明 | Source · 来源 |
|---|---|---|
| @isaacs/cliui@9.0.0 | Copyright; copyright in it. | ssh://git@github.com:isaacs/cliui |
| glob@11.1.0 | Copyright; copyright in it. | git@github.com:isaacs/node-glob |
| jackspeak@4.2.3 | Copyright; copyright in it. | https://github.com/isaacs/jackspeak |
| lru-cache@11.5.3 | Copyright; copyright in it. | ssh://git@github.com/isaacs/node-lru-cache |
| minimatch@10.2.6 | Copyright; copyright in it. | git@github.com:isaacs/minimatch |
| minipass@7.1.3 | Copyright; copyright in it. | https://github.com/isaacs/minipass |
| package-json-from-dist@1.0.1 | Copyright; copyright in it. | https://github.com/isaacs/package-json-from-dist |
| path-scurry@2.0.2 | Copyright; copyright in it. | https://github.com/isaacs/path-scurry |

License text shared by the packages above: · 上表各软件包共用的许可文本：

```text
Several modules are vendored under `./src`, which are used and
distributed according to their respective licenses, each provided
in the same directory as the code.

Everything else is released under the following license.

----

# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules. The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

## Copyright

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice. If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

**_As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim._**
```

### Apache-2.0 (6)

| Package · 软件包 | Copyright · 版权声明 | Source · 来源 |
|---|---|---|
| @electric-sql/pglite@0.2.15 | 2. Grant of Copyright License. Subject to the terms and conditions of; copyright license to reproduce, prepare Derivative Works of,; (c) You must retain, in the Source form of any Derivative Works; that You distribute, all copyright, patent, trademark, and; You may add Your own copyright statement to Your modifications and | https://pglite.dev |
| @mediapipe/tasks-vision@0.10.17 | Copyright (c) mediapipe@google.com | http://mediapipe.dev |
| draco3d@1.5.9 | Copyright (c) Google Draco Team | https://github.com/google/draco |
| hls.js@1.7.3 | Copyright (c) 2017 Dailymotion (http://www.dailymotion.com); That work is also covered by the Apache 2 License, following copyright:; Copyright (c) 2013-2015 Brightcove | https://github.com/video-dev/hls.js |
| jsqr@1.4.0 | 2. Grant of Copyright License. Subject to the terms and conditions of; copyright license to reproduce, prepare Derivative Works of,; (c) You must retain, in the Source form of any Derivative Works; that You distribute, all copyright, patent, trademark, and; You may add Your own copyright statement to Your modifications and | https://github.com/cozmo/jsQR |
| promise-worker-transferable@1.0.4 | 2. Grant of Copyright License. Subject to the terms and conditions of; copyright license to reproduce, prepare Derivative Works of,; (c) You must retain, in the Source form of any Derivative Works; that You distribute, all copyright, patent, trademark, and; You may add Your own copyright statement to Your modifications and | https://github.com/terikon/promise-worker-transferable#readme |

License text shared by the packages above: · 上表各软件包共用的许可文本：

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

### BSD-3-Clause (5)

#### @webgpu/types@0.1.74

Source · 来源: https://github.com/gpuweb/types

```text
Copyright 2022 WebGPU Developers

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

   1. Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.

   2. Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.

   3. Neither the name of the copyright holder nor the names of its
      contributors may be used to endorse or promote products derived from this
      software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

#### fast-uri@3.1.9

Source · 来源: https://github.com/fastify/fast-uri

```text
Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```

#### fast-uri@4.2.3

Source · 来源: https://github.com/fastify/fast-uri

```text
Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```

#### light-my-request@6.8.0

Source · 来源: https://github.com/fastify/light-my-request#readme

```text
Copyright (c) 2012-2014, Walmart
Copyright (c) 2012-2017, Project contributors
Copyright (c) 2017-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/hapijs/shot/graphs/contributors
- https://github.com/fastify/light-my-request/graphs/contributors
```

#### secure-json-parse@3.0.2

Source · 来源: https://github.com/fastify/secure-json-parse#readme

```text
Copyright (c) 2019 The Fastify Team
Copyright (c) 2019, Sideway Inc, and project contributors
All rights reserved.

The complete list of contributors can be found at:
- https://github.com/hapijs/bourne/graphs/contributors
- https://github.com/fastify/secure-json-parse/graphs/contributors

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### 0BSD (1)

#### tslib@2.8.1

Source · 来源: https://www.typescriptlang.org/

```text
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

