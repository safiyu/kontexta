# kontexta-reranker-model

ONNX weights for Kontexta's on-device models, packaged so `npx kontexta` works without downloading a model at runtime (corporate proxies commonly block the Hugging Face CDN).

Contents (each at a pinned commit, verified by size and sha256):

- `Xenova/ms-marco-MiniLM-L-6-v2` (`a091443`): the search reranker, full precision.
- `Xenova/all-MiniLM-L6-v2` (`751bff3`): the sentence-embedding model used for topic-pivot detection in journaling, int8 (`onnx/model_quantized.onnx`).

The files are not committed to git. `npm run fetch-weights` (also run automatically by `prepack`) downloads them from Hugging Face and verifies them against the pinned values in `scripts/fetch-weights.mjs`.

Model credit: ONNX exports by Xenova of `cross-encoder/ms-marco-MiniLM-L-6-v2` and `sentence-transformers/all-MiniLM-L6-v2` (sentence-transformers, Apache-2.0).
