import { invoke } from "@tauri-apps/api/core";

const MAX_OBSERVATION_BYTES = 5 * 1024 * 1024;
const MAX_CAPTURE_EDGE = 2200;

function waitForFrame(video) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("The selected window did not produce a frame.")), 5000);
    const finish = (error) => {
      window.clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    video.addEventListener("loadeddata", () => finish(), { once: true });
    video.addEventListener("error", () => finish(new Error("Could not read the selected window.")), { once: true });
  });
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the selected window.")), "image/png");
  });
}

export async function captureSelectedWindow() {
  if (window.__TAURI_INTERNALS__) {
    const nativeCapture = await invoke("capture_selected_window");
    if (nativeCapture.status === "captured") return nativeCapture;
    if (nativeCapture.status === "cancelled") {
      throw new Error("Window selection was cancelled.");
    }
    if (nativeCapture.status !== "unsupported") {
      throw new Error("The selected window could not be captured.");
    }
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Window selection is unavailable in this app build.");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "window" },
    audio: false,
    selfBrowserSurface: "exclude",
    systemAudio: "exclude",
    surfaceSwitching: "exclude",
    monitorTypeSurfaces: "exclude",
  });
  const track = stream.getVideoTracks()[0];
  let video;
  let canvas;
  try {
    const settings = track?.getSettings?.() ?? {};
    if (!track || settings.displaySurface !== "window") {
      throw new Error("Select a single application window. Screen and tab capture are not accepted.");
    }
    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitForFrame(video);
    const scale = Math.min(1, MAX_CAPTURE_EDGE / video.videoWidth, MAX_CAPTURE_EDGE / video.videoHeight);
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Could not prepare the selected window image.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = await canvasBlob(canvas);
    if (image.size > MAX_OBSERVATION_BYTES) {
      throw new Error("The selected window image is too large to send safely.");
    }
    const imageBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not prepare the selected window image."));
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
      reader.readAsDataURL(image);
    });
    return {
      application: "Selected window",
      windowTitle: track.label.slice(0, 500),
      accessibilityText: "",
      imageBase64,
    };
  } finally {
    for (const mediaTrack of stream.getTracks()) mediaTrack.stop();
    if (video) video.srcObject = null;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
