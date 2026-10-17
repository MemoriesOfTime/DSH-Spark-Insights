# spark protocol schemas

These files are the Protocol Buffer schemas from the official
[spark](https://github.com/lucko/spark) repository. They are kept here as the
authoritative reference for the file format; this is not a fork of spark.

- Source: `spark-common/src/main/proto/spark/`
- Pinned commit: `3e8745a76eaabe9a4f70aad6283876fb518d2ae8`
- License: GNU GPL v3.0 (see the repository `LICENSE` and `NOTICE`)

Files:

- `spark.proto` — shared metadata, statistics, health and metric messages
- `spark_sampler.proto` — sampler profiles and stack trees
- `spark_heap.proto` — heap summary exports

The schemas describe the current data version 2 format. Older spark exports may
use the legacy `time` / `children` fields that are now reserved in these files;
the parser keeps compatibility for those separately.

`lib/spark-pb.js` is generated from these files with `npm run generate:proto`.
The generated decoder is covered by the project GPL-3.0 license; the schemas
themselves remain attributed to the spark project.
