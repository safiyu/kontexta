# kontexta-reranker-model

ONNX weights for Kontexta's search reranker, packaged so `npx kontexta` works without downloading a model at runtime (corporate proxies commonly block the Hugging Face CDN).

Contents: `Xenova/ms-marco-MiniLM-L-6-v2` at commit `a091443` (`config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model.onnx`, 91 MB).

The files are not committed to git. `npm run fetch-weights` (also run automatically by `prepack`) downloads them from Hugging Face and verifies size and sha256 against the pinned values in `scripts/fetch-weights.mjs`.

Model credit: the ONNX export by Xenova of `cross-encoder/ms-marco-MiniLM-L-6-v2` (sentence-transformers, Apache-2.0).
