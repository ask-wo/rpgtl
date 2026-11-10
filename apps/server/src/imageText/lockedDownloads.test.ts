import { assert, it } from "@effect/vitest";
import {
  dryRunPlan,
  lockedFiles,
  lockedPythonMinor,
  plannedFiles,
  type Platform,
} from "./lockedDownloads.ts";

const files = "https://files.example";
const lock = `
version = 1
requires-python = "==3.12.*"

[[package]]
name = "numpy"
version = "2.2.6"
sdist = { url = "${files}/numpy-2.2.6.tar.gz", hash = "sha256:a", size = 1, upload-time = "2025-01-01T00:00:00Z" }
wheels = [
    { url = "${files}/numpy-2.2.6-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl", hash = "sha256:b", size = 2, upload-time = "2025-01-01T00:00:00Z" },
    { url = "${files}/numpy-2.2.6-cp312-cp312-manylinux_2_28_x86_64.whl", hash = "sha256:c", size = 3, upload-time = "2025-01-01T00:00:00Z" },
    { url = "${files}/numpy-2.2.6-cp312-cp312-manylinux_2_40_x86_64.whl", hash = "sha256:d", size = 4, upload-time = "2025-01-01T00:00:00Z" },
    { url = "${files}/numpy-2.2.6-cp313-cp313-manylinux_2_28_x86_64.whl", hash = "sha256:e", size = 5, upload-time = "2025-01-01T00:00:00Z" },
    { url = "${files}/numpy-2.2.6-cp312-cp312-win_amd64.whl", hash = "sha256:f", size = 6, upload-time = "2025-01-01T00:00:00Z" },
]

[[package]]
name = "opencv-python-headless"
version = "4.10.0.84"
wheels = [
    { url = "${files}/opencv_python_headless-4.10.0.84-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl", hash = "sha256:g", size = 7, upload-time = "2025-01-01T00:00:00Z" },
    { url = "${files}/opencv_python_headless-4.10.0.84-cp37-abi3-manylinux_2_17_aarch64.whl", hash = "sha256:h", size = 8, upload-time = "2025-01-01T00:00:00Z" },
]

[[package]]
name = "typing-extensions"
version = "4.16.0"
wheels = [
    { url = "${files}/typing_extensions-4.16.0-py3-none-any.whl", hash = "sha256:i", size = 9, upload-time = "2025-01-01T00:00:00Z" },
]

[[package]]
name = "pyclipper"
version = "1.3.0.post6"
sdist = { url = "${files}/pyclipper-1.3.0.post6.tar.gz", hash = "sha256:j", size = 10, upload-time = "2025-01-01T00:00:00Z" }

[[package]]
name = "torch"
version = "2.9.0+cpu"
wheels = [
    { url = "${files}/torch-2.9.0%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl", hash = "sha256:k", upload-time = "2025-01-01T00:00:00Z" },
]
`;

const linux: Platform = { os: "linux", pythonMinor: 12, glibc: [2, 39] };
const plan = dryRunPlan([
  // What uv says when the environment exists from an attempt that failed: no Python version.
  "Would use project environment at: venv",
  "Would download 5 packages",
  "+ numpy==2.2.6",
  "+ opencv-python-headless==4.10.0.84",
  "+ typing-extensions==4.16.0",
  "+ pyclipper==1.3.0.post6",
  "+ torch==2.9.0+cpu",
  "+ convert-lama==0.1.0",
]);
const names = (platform: Platform) =>
  plannedFiles(lockedFiles(lock), plan, platform).map(
    ({ url, size }) => `${decodeURIComponent(url.slice(files.length + 1))} ${size}`,
  );

it("takes the packages from uv's dry run, and the Python from the lockfile", () => {
  assert.strictEqual(plan.length, 6);
  assert.deepInclude(plan, { name: "torch", version: "2.9.0+cpu" });
  assert.strictEqual(lockedPythonMinor(lock), 12);
  assert.isUndefined(lockedPythonMinor('requires-python = ">=3.12"'));
});

it("picks the wheel uv downloads for Linux: the newest manylinux the C library allows", () => {
  assert.deepStrictEqual(names(linux), [
    "numpy-2.2.6-cp312-cp312-manylinux_2_28_x86_64.whl 3",
    "opencv_python_headless-4.10.0.84-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl 7",
    "typing_extensions-4.16.0-py3-none-any.whl 9",
    "pyclipper-1.3.0.post6.tar.gz 10",
    "torch-2.9.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl undefined",
  ]);
  // An older C library only allows the older wheel.
  assert.include(
    names({ ...linux, glibc: [2, 27] }),
    "numpy-2.2.6-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl 2",
  );
});

it("picks the Windows wheel on Windows, and the source archive when no wheel fits", () => {
  assert.deepStrictEqual(names({ ...linux, os: "windows" }), [
    "numpy-2.2.6-cp312-cp312-win_amd64.whl 6",
    "typing_extensions-4.16.0-py3-none-any.whl 9",
    "pyclipper-1.3.0.post6.tar.gz 10",
  ]);
});
