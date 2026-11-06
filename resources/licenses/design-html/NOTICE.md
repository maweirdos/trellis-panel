# Design HTML parsers

The design tool and local design service use parse5 8.0.0 (MIT) and css-tree 3.1.0 (MIT) to validate declared HTML and CSS dependencies. Their runtime dependencies include entities 6.0.1 (BSD-2-Clause), mdn-data 2.12.2 (CC0-1.0), and source-map-js 1.2.1 (BSD-3-Clause).

The corresponding license texts are included in this directory. The external Pi runtime includes these packages through `scripts/prepare-pi-runtime.mjs`.
