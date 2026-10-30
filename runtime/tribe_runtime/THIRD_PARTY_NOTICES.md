# Third-party notices

Tribe's local scanned-PDF OCR bundles these third-party components. Their upstream names are used only to identify the software and model sources; no endorsement is implied.

## RapidOCR 3.10.0

RapidOCR source code is copyright the RapidOCR Authors and licensed under the Apache License, Version 2.0. Tribe pins RapidOCR 3.10.0 (wheel SHA-256 `2fc34e26cd0f48514804a94f8832283039c7334076bff60768b1fed9ad068050`). Its default ONNX configuration includes converted model artifacts derived from official PaddleOCR models. The applicable upstream model weights are copyright Baidu and/or the relevant PaddleOCR rights holders and licensed under Apache-2.0. The RapidOCR project publishes the provenance, redistribution terms and model hashes in its [model licence notice](https://rapidai.github.io/RapidOCRDocs/main/en/model_licenses/).

Bundled default models:

- `PP-OCRv6_det_small.onnx` — SHA-256 `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f`
- `PP-OCRv6_rec_small.onnx` — SHA-256 `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884`
- `ch_ppocr_mobile_v2.0_cls_mobile.onnx` — SHA-256 `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c`

The complete Apache-2.0 licence text is in `third_party/LICENSE-APACHE-2.0.txt`.

## ONNX Runtime 1.23.x

Copyright Microsoft Corporation. Tribe pins ONNX Runtime 1.23.2, licensed under the [MIT License](https://github.com/microsoft/onnxruntime/blob/v1.23.2/LICENSE).

## pypdfium2 5.x and PDFium

Tribe pins pypdfium2 5.14.0, licensed under [Apache-2.0 and BSD-3-Clause](https://github.com/pypdfium2-team/pypdfium2/blob/main/LICENSE). The bundled PDFium binaries are licensed under [BSD-3-Clause](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE).

## OpenCV 4.14.0.94

OpenCV is copyright the OpenCV team and contributors and licensed under [Apache-2.0](https://github.com/opencv/opencv/blob/4.14.0/LICENSE). Tribe uses the headless Python distribution for OCR image processing.
