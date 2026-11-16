
# OCR 资源来源

本目录包含应用在浏览器本地识别时加载的上游发行文件。worker、引擎和语言模型由同一站点提供，版本固定，模型在使用时按需加载。

| 文件 | 上游来源 |
| --- | --- |
| tesseract.min.js、worker.min.js | [tesseract.js 6.0.1](https://www.npmjs.com/package/tesseract.js/v/6.0.1) |
| tesseract-core-lstm.wasm.js、tesseract-core-simd-lstm.wasm.js | [tesseract.js-core 6.0.0](https://www.npmjs.com/package/tesseract.js-core/v/6.0.0) |
| chi_sim.traineddata.gz | [@tesseract.js-data/chi_sim 1.0.0](https://www.npmjs.com/package/@tesseract.js-data/chi_sim/v/1.0.0) 内的 4.0.0_best_int/chi_sim.traineddata.gz |
| eng.traineddata.gz | [@tesseract.js-data/eng 1.0.0](https://www.npmjs.com/package/@tesseract.js-data/eng/v/1.0.0) 内的 4.0.0_best_int/eng.traineddata.gz |

LSTM 核心的两个发行文件均内嵌 WebAssembly。支持 SIMD 的设备加载 SIMD 核心，其余设备加载标量核心。语言模型为 [Project Naptha 的整数化 Tessdata Best](https://github.com/naptha/tessdata#language-data)。对应许可证随目录分发。
