# AI-Denoise Models — Sources & Licenses

The `.onnx` files in this directory are **not** checked into git
(see `.gitignore`). They are fetched on demand by
[`scripts/fetch-denoise-models.sh`](../../../scripts/fetch-denoise-models.sh)
and cached in the user's browser OPFS on first use.

Each entry below lists the upstream source (so the trained weights are
attributable), the redistribution we pull from, and the license terms
that apply to the weights. If you add or rotate a model, update both
this file and the registry in
[`src/engine/ai/denoise/modelStore.ts`](../../../src/engine/ai/denoise/modelStore.ts).

## scunet-psnr.v1.onnx — SCUNet (real-world PSNR)

- **Architecture:** Swin-Conv-UNet (SCUNet)
  — Zhang et al., *Practical Blind Denoising via Swin-Conv-UNet and
  Data Synthesis*, Machine Intelligence Research 2023.
- **Upstream weights:** `scunet_color_real_psnr` from
  https://github.com/cszn/SCUNet
- **ONNX export & redistribution:**
  https://huggingface.co/deepghs/image_restoration (filename
  `SCUNet-PSNR.onnx`)
- **Size:** 88 MB
- **SHA-256:**
  `b0f8c12f1575bb49e39a85924152f1c6d4b527a4aae0432c9e5c7397123465e3`
- **ONNX tensor I/O:** input `input`, output `output`, NCHW float32,
  range `[0, 1]`, 3 channels RGB.
- **License of weights:** Apache 2.0 (upstream cszn/SCUNet repo).
  The deepghs redistribution declares MIT — we follow the upstream
  Apache 2.0 because the weights originate there.
- **Attribution required:** yes — credit Kai Zhang et al. (SCUNet)
  in the app's open-source notices.
